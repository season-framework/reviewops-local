#include <Foundation/Foundation.h>
#include <Security/SecAccess.h>
#include <Security/SecKeychain.h>
#include <Security/SecKeychainItem.h>
#include <Security/SecTrustedApplication.h>
#include <CommonCrypto/CommonDigest.h>
#include <node_api.h>
#include <array>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <new>
#include <thread>

#if NAPI_VERSION != 8
#error This Source requires the reviewed NAPI_VERSION=8 build contract.
#endif

namespace {
constexpr char kService[] = "kr.co.season.reviewops.remote-device-identity.v1";
constexpr size_t kPayloadMax = 65536;
constexpr size_t kReferenceMax = 4096;

// Only fixed codes and actual returned OSStatus values cross this native boundary.
struct Outcome {
  const char* code = nullptr;
  bool hasStatus = false;
  int32_t status = 0;
  bool itemMayRemain = false;
  bool memoryUnconfirmed = false;
  bool policyFailed = false;
  bool napiFailed = false;
  void Fail(const char* fixedCode, bool actualStatus = false, OSStatus value = 0) noexcept {
    if (!code) { code = fixedCode; hasStatus = actualStatus; status = static_cast<int32_t>(value); }
  }
  bool Failed() const noexcept { return code != nullptr; }
  bool MayRemain() const noexcept { return itemMayRemain || memoryUnconfirmed; }
};

void Wipe(void* pointer, size_t length) noexcept {
  volatile unsigned char* bytes = static_cast<volatile unsigned char*>(pointer);
  while (bytes && length--) *bytes++ = 0;
}
bool EqualBytes(const void* a, const void* b, size_t length) noexcept {
  const auto* x = static_cast<const unsigned char*>(a);
  const auto* y = static_cast<const unsigned char*>(b);
  volatile unsigned char difference = 0;
  for (size_t i = 0; i < length; ++i) difference = static_cast<unsigned char>(difference | (x[i] ^ y[i]));
  return difference == 0;
}
template<size_t Capacity> struct Snapshot {
  std::array<unsigned char, Capacity> bytes{};
  size_t length = 0;
  Snapshot() = default;
  Snapshot(const Snapshot&) = delete;
  Snapshot& operator=(const Snapshot&) = delete;
  ~Snapshot() { Wipe(bytes.data(), bytes.size()); }
};
struct Output {
  napi_value value = nullptr;
  void* bytes = nullptr;  // Valid only after napi_create_buffer returned napi_ok.
  size_t length = 0;
  void Withhold() noexcept { Wipe(bytes, length); bytes = nullptr; length = 0; value = nullptr; }
};
struct EnvTag { napi_env env; std::thread::id thread; napi_ref emergency = nullptr; };
enum class Phase { New, Ready, Failed, Closed };
struct Singleton {
  std::mutex mutex;
  Phase phase = Phase::New;
  EnvTag* owner = nullptr;
  std::atomic<EnvTag*> ownerSignal{nullptr};
  std::atomic<bool> closedSignal{false};
  std::array<char, 37> account{};
};
Singleton g;

bool Napi(Outcome& outcome, napi_status status) noexcept {
  if (status == napi_ok) return true;
  outcome.Fail("NAPI_FAILURE"); outcome.napiFailed = true; return false;
}
template<class Function>
bool OS(Outcome& outcome, const char* code, Function function) noexcept {
  try {
    @try {
      @autoreleasepool {
        const OSStatus status = function();
        if (status == errSecSuccess) return true;
        outcome.Fail(code, true, status); return false;
      }
    } @catch (NSException* exception) { (void)exception; outcome.Fail("NATIVE_EXCEPTION"); return false; }
  } catch (...) { outcome.Fail("NATIVE_EXCEPTION"); return false; }
}
bool NoUI(Outcome& outcome) noexcept {
  Boolean before = false, after = true;
  if (!OS(outcome, "NO_UI_GET_FAILED", [&] { return SecKeychainGetUserInteractionAllowed(&before); }) ||
      !OS(outcome, "NO_UI_SET_FAILED", [] { return SecKeychainSetUserInteractionAllowed(false); }) ||
      !OS(outcome, "NO_UI_VERIFY_FAILED", [&] { return SecKeychainGetUserInteractionAllowed(&after); })) {
    outcome.policyFailed = true; return false;
  }
  if (after) { outcome.Fail("NO_UI_NOT_ENFORCED"); outcome.policyFailed = true; return false; }
  return true;  // Never restore the process-wide setting, including close/failure/cleanup.
}
template<class Function>
bool Target(Outcome& outcome, const char* code, Function function) noexcept {
  return NoUI(outcome) && OS(outcome, code, function);
}
bool Type(Outcome& outcome, CFTypeRef object, CFTypeID expected) {
  if (object && CFGetTypeID(object) == expected) return true;
  outcome.Fail("NATIVE_SHAPE_REFUSED"); return false;
}
template<class Reference>
void Release(Reference& reference, Outcome& outcome) noexcept {
  const Reference owned = reference; reference = nullptr;
  if (!owned) return;
  try {
    @try { @autoreleasepool { CFRelease(owned); } }
    @catch (NSException* exception) { (void)exception; outcome.Fail("CF_RELEASE_FAILED"); outcome.memoryUnconfirmed = true; }
  } catch (...) { outcome.Fail("CF_RELEASE_FAILED"); outcome.memoryUnconfirmed = true; }
}

struct Resources {
  SecKeychainRef target = nullptr, actual = nullptr, finalDefault = nullptr;
  SecTrustedApplicationRef creator = nullptr;
  CFArrayRef creatorList = nullptr;
  SecAccessRef access = nullptr;
  SecKeychainItemRef item = nullptr;
  CFDataRef reference = nullptr;
  SecKeychainAttributeList* attributes = nullptr;
  void* payload = nullptr;
  UInt32 payloadLength = 0;
  bool createStarted = false, createReturned = false, ownTypedCreate = false;
  bool deletionAttempted = false;
};
void FreeRead(Resources& resources, Outcome& outcome) noexcept {
  auto* attributes = resources.attributes;
  void* payload = resources.payload;
  const UInt32 length = resources.payloadLength;
  resources.attributes = nullptr; resources.payload = nullptr; resources.payloadLength = 0;
  if (!attributes && !payload) return;
  // The trusted public API owns this returned allocation and supplied its length.
  Wipe(payload, length);
  if (!OS(outcome, "READ_FREE_FAILED", [&] { return SecKeychainItemFreeAttributesAndData(attributes, payload); }))
    outcome.memoryUnconfirmed = true;  // No uncertain matching-free retry or CFRelease of these allocations.
}
void Cleanup(Resources& resources, Outcome& outcome) noexcept {
  FreeRead(resources, outcome);
  Release(resources.reference, outcome);
  Release(resources.finalDefault, outcome);
  Release(resources.actual, outcome);
  Release(resources.access, outcome);
  Release(resources.creatorList, outcome);
  Release(resources.creator, outcome);
  Release(resources.target, outcome);
  if (outcome.Failed() && resources.ownTypedCreate && resources.item && !resources.deletionAttempted) {
    resources.deletionAttempted = true;
    // Authority is only the exact retained typed item from our returned create status 0.
    if (Target(outcome, "OWN_CREATE_CLEANUP_FAILED", [&] { return SecKeychainItemDelete(resources.item); }))
      outcome.itemMayRemain = false;
  }
  // The item stays retained until every other fallible preparation/cleanup and any own-delete attempt.
  // An exceptional CFRelease leaves ownership uncertain: do not reuse a possibly released pointer.
  Release(resources.item, outcome);
}

bool UUID(const std::array<char, 37>& value) noexcept {
  for (size_t i = 0; i < 36; ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (value[i] != '-') return false; }
    else if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return false;
  }
  return value[14] == '4' && (value[19] == '8' || value[19] == '9' || value[19] == 'a' || value[19] == 'b') && value[36] == '\0';
}
bool Account(napi_env env, napi_value input, std::array<char, 37>& account, Outcome& outcome) {
  napi_valuetype type; size_t length = 0, written = 0;
  if (!Napi(outcome, napi_typeof(env, input, &type))) return false;
  if (type != napi_string) { outcome.Fail("ACCOUNT_REFUSED"); return false; }
  if (!Napi(outcome, napi_get_value_string_utf8(env, input, nullptr, 0, &length))) return false;
  if (length != 36) { outcome.Fail("ACCOUNT_REFUSED"); return false; }
  if (!Napi(outcome, napi_get_value_string_utf8(env, input, account.data(), account.size(), &written))) return false;
  if (written != 36 || !UUID(account)) { outcome.Fail("ACCOUNT_REFUSED"); return false; }
  return true;
}
template<size_t Capacity>
bool Buffer(napi_env env, napi_value input, size_t minimum, size_t maximum, Snapshot<Capacity>& result, Outcome& outcome) {
  bool buffer = false, ordinary = false, detached = true;
  napi_typedarray_type type; size_t elements = 0, offset = 0, length = 0;
  void* typedBytes = nullptr; void* bytes = nullptr; void* backing = nullptr;
  size_t backingLength = 0; napi_value arraybuffer = nullptr;
  if (!Napi(outcome, napi_is_buffer(env, input, &buffer))) return false;
  if (!buffer) { outcome.Fail("BUFFER_REFUSED"); return false; }
  if (!Napi(outcome, napi_get_typedarray_info(env, input, &type, &elements, &typedBytes, &arraybuffer, &offset)) ||
      !Napi(outcome, napi_is_arraybuffer(env, arraybuffer, &ordinary))) return false;
  if (!ordinary) { outcome.Fail("SHARED_BUFFER_REFUSED"); return false; }
  if (!Napi(outcome, napi_is_detached_arraybuffer(env, arraybuffer, &detached))) return false;
  if (detached) { outcome.Fail("DETACHED_BUFFER_REFUSED"); return false; }
  if (!Napi(outcome, napi_get_buffer_info(env, input, &bytes, &length)) ||
      !Napi(outcome, napi_get_arraybuffer_info(env, arraybuffer, &backing, &backingLength))) return false;
  if (type != napi_uint8_array || length != elements || bytes != typedBytes || !bytes || length < minimum || length > maximum || length > Capacity) {
    outcome.Fail("BUFFER_REFUSED"); return false;
  }
  if (!backing || offset > backingLength || length > backingLength - offset ||
      static_cast<unsigned char*>(backing) + offset != bytes) { outcome.Fail("BUFFER_REFUSED"); return false; }
  std::memcpy(result.bytes.data(), bytes, length); result.length = length; return true;
}
bool Undefined(napi_env env, Output& output, Outcome& outcome) {
  return Napi(outcome, napi_get_undefined(env, &output.value));
}
bool PrepareBuffer(napi_env env, const void* bytes, size_t length, Output& output, Outcome& outcome) {
  void* allocated = nullptr; napi_value value = nullptr;
  if (!Napi(outcome, napi_create_buffer(env, length, &allocated, &value))) return false;
  output.bytes = allocated; output.length = allocated ? length : 0; output.value = value;
  if (!allocated || !value) { outcome.Fail("NAPI_FAILURE"); outcome.napiFailed = true; return false; }
  // Private bytes are copied only after successful, fully owned NAPI allocation.
  std::memcpy(allocated, bytes, length); return true;
}
bool CaptureDefault(Resources& resources, Outcome& outcome) {
  if (!Target(outcome, "DEFAULT_KEYCHAIN_FAILED", [&] { return SecKeychainCopyDefault(&resources.target); }) ||
      !Type(outcome, resources.target, SecKeychainGetTypeID())) return false;
  SecKeychainStatus flags = 0;
  if (!Target(outcome, "DEFAULT_STATUS_FAILED", [&] { return SecKeychainGetStatus(resources.target, &flags); })) return false;
  if (!(flags & kSecUnlockStateStatus)) { outcome.Fail("DEFAULT_LOCKED"); return false; }
  return true;
}
bool CreatorAccess(Resources& resources, Outcome& outcome) {
  if (!Target(outcome, "CREATOR_APPLICATION_FAILED", [&] { return SecTrustedApplicationCreateFromPath(nullptr, &resources.creator); }) ||
      !Type(outcome, resources.creator, SecTrustedApplicationGetTypeID())) return false;
  const void* values[] = {resources.creator};
  resources.creatorList = CFArrayCreate(kCFAllocatorDefault, values, 1, &kCFTypeArrayCallBacks);
  if (!Type(outcome, resources.creatorList, CFArrayGetTypeID()) || CFArrayGetCount(resources.creatorList) != 1 ||
      CFArrayGetValueAtIndex(resources.creatorList, 0) != resources.creator) { outcome.Fail("CREATOR_LIST_REFUSED"); return false; }
  return Target(outcome, "CREATOR_ACCESS_FAILED", [&] { return SecAccessCreate(CFSTR("ReviewOps remote device identity"), resources.creatorList, &resources.access); }) &&
    Type(outcome, resources.access, SecAccessGetTypeID());
}
bool Attributes(Resources& resources, Outcome& outcome) {
  auto* attributes = resources.attributes;
  if (!attributes || attributes->count != 2 || !attributes->attr) { outcome.Fail("ATTRIBUTES_REFUSED"); return false; }
  bool service = false, account = false;
  for (UInt32 i = 0; i < 2; ++i) {
    const auto& attribute = attributes->attr[i];
    if (attribute.tag == kSecServiceItemAttr && !service && attribute.length == sizeof(kService) - 1 && attribute.data &&
        std::memcmp(attribute.data, kService, sizeof(kService) - 1) == 0) service = true;
    else if (attribute.tag == kSecAccountItemAttr && !account && attribute.length == 36 && attribute.data &&
             std::memcmp(attribute.data, g.account.data(), 36) == 0) account = true;
    else { outcome.Fail("ATTRIBUTES_REFUSED"); return false; }
  }
  return service && account;
}
bool ValidateAndRead(Resources& resources, Outcome& outcome) {
  if (!Target(outcome, "ITEM_KEYCHAIN_FAILED", [&] { return SecKeychainItemCopyKeychain(resources.item, &resources.actual); }) ||
      !Type(outcome, resources.actual, SecKeychainGetTypeID())) return false;
  if (!CFEqual(resources.target, resources.actual)) { outcome.Fail("TARGET_MISMATCH"); return false; }
  UInt32 tags[] = {kSecServiceItemAttr, kSecAccountItemAttr};
  UInt32 formats[] = {CSSM_DB_ATTRIBUTE_FORMAT_STRING, CSSM_DB_ATTRIBUTE_FORMAT_STRING};
  SecKeychainAttributeInfo info = {2, tags, formats}; SecItemClass itemClass = static_cast<SecItemClass>(0);
  if (!Target(outcome, "ITEM_READ_FAILED", [&] {
    return SecKeychainItemCopyAttributesAndData(resources.item, &info, &itemClass, &resources.attributes, &resources.payloadLength, &resources.payload);
  })) return false;
  if (itemClass != kSecGenericPasswordItemClass) { outcome.Fail("CLASS_MISMATCH"); return false; }
  if (!Attributes(resources, outcome)) return false;
  if (!resources.payload || resources.payloadLength < 1 || resources.payloadLength > kPayloadMax) {
    outcome.Fail("PAYLOAD_SIZE_REFUSED"); return false;  // Never truncate an oversized native allocation.
  }
  return true;
}
bool Resolve(Resources& resources, const Snapshot<kReferenceMax>& reference, Outcome& outcome) {
  resources.reference = CFDataCreate(kCFAllocatorDefault, reference.bytes.data(), static_cast<CFIndex>(reference.length));
  return Type(outcome, resources.reference, CFDataGetTypeID()) &&
    Target(outcome, "REFERENCE_RESOLVE_FAILED", [&] { return SecKeychainItemCopyFromPersistentReference(resources.reference, &resources.item); }) &&
    Type(outcome, resources.item, SecKeychainItemGetTypeID());
}
bool FinalDefault(Resources& resources, Outcome& outcome) {
  if (!Target(outcome, "FINAL_DEFAULT_FAILED", [&] { return SecKeychainCopyDefault(&resources.finalDefault); }) ||
      !Type(outcome, resources.finalDefault, SecKeychainGetTypeID())) return false;
  if (!CFEqual(resources.target, resources.finalDefault) || !CFEqual(resources.actual, resources.finalDefault)) {
    outcome.Fail("TARGET_CHANGED"); return false;
  }
  return true;
}

enum class Operation { Initialize, Create, Read, Remove, Close };
void Perform(napi_env env, EnvTag* tag, Operation operation, const napi_value* args, Resources& resources, Output& output, Outcome& outcome) {
  if (g.closedSignal.load() || g.phase == Phase::Closed) { outcome.Fail("PROVIDER_CLOSED"); return; }
  if (g.owner && (g.owner != tag || tag->env != env || tag->thread != std::this_thread::get_id())) { outcome.Fail("OWNER_CONTEXT_REFUSED"); return; }
  if (operation == Operation::Close) { g.closedSignal.store(true); g.phase = Phase::Closed; Undefined(env, output, outcome); return; }
  if (operation == Operation::Initialize) {
    std::array<char, 37> account{};
    if (!Account(env, args[0], account, outcome)) return;
    if (g.phase == Phase::Failed) { outcome.Fail("PROVIDER_FAILED"); return; }
    if (g.phase == Phase::New) { g.owner = tag; g.ownerSignal.store(tag); g.account = account; }
    else if (g.account != account) { outcome.Fail("ACCOUNT_IMMUTABLE"); return; }
    // Observe the current default vault before JS publishes a new pending
    // intent. Create still repeats this check: preflight cannot prevent a later
    // lock or default change and is never proof about an old failed operation.
    if (CaptureDefault(resources, outcome) && Undefined(env, output, outcome)) g.phase = Phase::Ready;
    else g.phase = Phase::Failed;
    return;
  }
  if (g.phase != Phase::Ready || !g.owner) { outcome.Fail("PROVIDER_NOT_READY"); return; }
  Snapshot<kPayloadMax> payload;
  Snapshot<kReferenceMax> reference;
  Snapshot<CC_SHA256_DIGEST_LENGTH> expectedDigest;
  if (operation == Operation::Create) {
    if (!Buffer(env, args[0], 1, kPayloadMax, payload, outcome) || !CaptureDefault(resources, outcome) || !CreatorAccess(resources, outcome)) return;
    SecKeychainAttribute attributes[] = {
      {kSecServiceItemAttr, static_cast<UInt32>(sizeof(kService) - 1), const_cast<char*>(kService)},
      {kSecAccountItemAttr, 36, g.account.data()}
    };
    SecKeychainAttributeList list = {2, attributes};
    if (!Target(outcome, "ITEM_CREATE_FAILED", [&] {
      resources.createStarted = true; outcome.itemMayRemain = true;
      const OSStatus status = SecKeychainItemCreateFromContent(kSecGenericPasswordItemClass, &list, static_cast<UInt32>(payload.length), payload.bytes.data(), resources.target, resources.access, &resources.item);
      resources.createReturned = true;
      // Capture both returned zero and the typed retained authority before pool drain or later work.
      if (status == errSecSuccess && resources.item && CFGetTypeID(resources.item) == SecKeychainItemGetTypeID())
        resources.ownTypedCreate = true;
      return status;
    })) return;
    if (!Type(outcome, resources.item, SecKeychainItemGetTypeID()) || !resources.ownTypedCreate) {
      outcome.Fail("NATIVE_SHAPE_REFUSED"); return;
    }
    if (!ValidateAndRead(resources, outcome)) return;
    if (resources.payloadLength != payload.length || !EqualBytes(resources.payload, payload.bytes.data(), payload.length)) { outcome.Fail("CREATE_READBACK_MISMATCH"); return; }
    if (!Target(outcome, "REFERENCE_CREATE_FAILED", [&] { return SecKeychainItemCreatePersistentReference(resources.item, &resources.reference); }) ||
        !Type(outcome, resources.reference, CFDataGetTypeID())) return;
    const CFIndex length = CFDataGetLength(resources.reference); const UInt8* bytes = CFDataGetBytePtr(resources.reference);
    if (length < 1 || length > static_cast<CFIndex>(kReferenceMax) || !bytes) { outcome.Fail("REFERENCE_SIZE_REFUSED"); return; }
    if (!FinalDefault(resources, outcome)) return;
    PrepareBuffer(env, bytes, static_cast<size_t>(length), output, outcome); return;
  }
  if (!Buffer(env, args[0], 1, kReferenceMax, reference, outcome)) return;
  if (operation == Operation::Remove && !Buffer(env, args[1], CC_SHA256_DIGEST_LENGTH, CC_SHA256_DIGEST_LENGTH, expectedDigest, outcome)) return;
  outcome.itemMayRemain = true;  // Neither a reference nor a failed operation proves item absence.
  if (!CaptureDefault(resources, outcome) || !Resolve(resources, reference, outcome) || !ValidateAndRead(resources, outcome)) return;
  if (operation == Operation::Read) {
    if (FinalDefault(resources, outcome)) PrepareBuffer(env, resources.payload, resources.payloadLength, output, outcome);
    return;
  }
  Snapshot<CC_SHA256_DIGEST_LENGTH> actualDigest;
  if (!CC_SHA256(resources.payload, static_cast<CC_LONG>(resources.payloadLength), actualDigest.bytes.data())) { outcome.Fail("DIGEST_FAILED"); return; }
  actualDigest.length = actualDigest.bytes.size();
  if (!EqualBytes(actualDigest.bytes.data(), expectedDigest.bytes.data(), actualDigest.length)) { outcome.Fail("DIGEST_MISMATCH"); return; }
  FreeRead(resources, outcome);  // Refuse deletion if matching native-memory cleanup failed.
  if (outcome.Failed() || !Undefined(env, output, outcome)) return;
  if (!FinalDefault(resources, outcome)) return;
  resources.deletionAttempted = true;
  if (Target(outcome, "ITEM_DELETE_FAILED", [&] { return SecKeychainItemDelete(resources.item); })) outcome.itemMayRemain = false;
}

bool ErrorValue(napi_env env, const Outcome& outcome, napi_value* result) noexcept {
  napi_value object = nullptr, code = nullptr, status = nullptr, mayRemain = nullptr;
  if (napi_create_object(env, &object) != napi_ok ||
      napi_create_string_utf8(env, outcome.code ? outcome.code : "NAPI_FAILURE", NAPI_AUTO_LENGTH, &code) != napi_ok ||
      (outcome.hasStatus ? napi_create_int32(env, outcome.status, &status) : napi_get_null(env, &status)) != napi_ok ||
      napi_get_boolean(env, outcome.MayRemain(), &mayRemain) != napi_ok) return false;
  const napi_property_descriptor fields[] = {
    {"code", nullptr, nullptr, nullptr, nullptr, code, napi_enumerable, nullptr},
    {"osStatus", nullptr, nullptr, nullptr, nullptr, status, napi_enumerable, nullptr},
    {"mayRemain", nullptr, nullptr, nullptr, nullptr, mayRemain, napi_enumerable, nullptr}
  };
  if (napi_define_properties(env, object, sizeof(fields) / sizeof(fields[0]), fields) != napi_ok ||
      napi_object_freeze(env, object) != napi_ok) return false;
  *result = object; return true;
}
napi_value Throw(napi_env env, EnvTag* tag, const Outcome& outcome) noexcept {
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
    napi_value discarded = nullptr; napi_get_and_clear_last_exception(env, &discarded);
  }
  napi_value error = nullptr;
  if (!ErrorValue(env, outcome, &error)) {
    pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
      napi_value discarded = nullptr; napi_get_and_clear_last_exception(env, &discarded);
    }
    if (!tag || !tag->emergency || napi_get_reference_value(env, tag->emergency, &error) != napi_ok) return nullptr;
  }
  napi_throw(env, error); return nullptr;  // A thrown plain fixed-shape object has no native description/path/stack.
}
void EnvironmentClosed(void* pointer) noexcept {
  auto* tag = static_cast<EnvTag*>(pointer);
  if (g.ownerSignal.load() == tag) g.closedSignal.store(true);
  try {
    std::lock_guard<std::mutex> lock(g.mutex);
    if (g.owner == tag) { g.phase = Phase::Closed; g.owner = nullptr; g.ownerSignal.store(nullptr); }
  } catch (...) { /* Environment teardown cannot publish a successful operation. */ }
  // NAPI owns its references until environment teardown; no target operation or UI restore here.
  delete tag;
}
napi_value Dispatch(napi_env env, napi_callback_info info, Operation operation) noexcept {
  Outcome outcome; Resources resources; Output output; EnvTag* tag = nullptr;
  std::unique_lock<std::mutex> lock;
  try {
    size_t count = 3; napi_value args[3] = {}; void* data = nullptr;
    if (!Napi(outcome, napi_get_cb_info(env, info, &count, args, nullptr, &data))) return Throw(env, nullptr, outcome);
    tag = static_cast<EnvTag*>(data);
    const size_t wanted = operation == Operation::Close ? 0 : operation == Operation::Remove ? 2 : 1;
    if (!tag || tag->env != env || count != wanted) { outcome.Fail("ARGUMENTS_REFUSED"); return Throw(env, tag, outcome); }
    lock = std::unique_lock<std::mutex>(g.mutex, std::try_to_lock);
    if (!lock.owns_lock()) { outcome.Fail("PROVIDER_BUSY"); return Throw(env, tag, outcome); }
    @try {
      @autoreleasepool { Perform(env, tag, operation, args, resources, output, outcome); }
    } @catch (NSException* exception) { (void)exception; outcome.Fail("NATIVE_EXCEPTION"); }
    if (!outcome.Failed() && !output.value) { outcome.Fail("NAPI_FAILURE"); outcome.napiFailed = true; }
    Cleanup(resources, outcome);
    if (outcome.policyFailed || outcome.memoryUnconfirmed || outcome.napiFailed) g.phase = Phase::Failed;
    if (outcome.Failed()) { output.Withhold(); lock.unlock(); return Throw(env, tag, outcome); }
    // This successful callback return is the publication boundary. No more native/NAPI work follows.
    return output.value;
  } catch (...) {
    outcome.Fail("NATIVE_EXCEPTION");
    Cleanup(resources, outcome); output.Withhold();
    if (lock.owns_lock()) { g.phase = Phase::Failed; lock.unlock(); }
    return Throw(env, tag, outcome);
  }
}
napi_value Initialize(napi_env env, napi_callback_info info) { return Dispatch(env, info, Operation::Initialize); }
napi_value Create(napi_env env, napi_callback_info info) { return Dispatch(env, info, Operation::Create); }
napi_value Read(napi_env env, napi_callback_info info) { return Dispatch(env, info, Operation::Read); }
napi_value Remove(napi_env env, napi_callback_info info) { return Dispatch(env, info, Operation::Remove); }
napi_value Close(napi_env env, napi_callback_info info) { return Dispatch(env, info, Operation::Close); }
napi_value Module(napi_env env, napi_value exports) {
  Outcome emergency; emergency.Fail("NAPI_FAILURE"); emergency.itemMayRemain = true;
  napi_value fallback = nullptr;
  if (!ErrorValue(env, emergency, &fallback)) return nullptr;
  auto* tag = new (std::nothrow) EnvTag{env, std::this_thread::get_id(), nullptr};
  if (!tag) { napi_throw(env, fallback); return nullptr; }
  if (napi_create_reference(env, fallback, 1, &tag->emergency) != napi_ok) { napi_throw(env, fallback); delete tag; return nullptr; }
  if (napi_add_env_cleanup_hook(env, EnvironmentClosed, tag) != napi_ok) {
    napi_delete_reference(env, tag->emergency); napi_throw(env, fallback); delete tag; return nullptr;
  }
  const napi_property_descriptor methods[] = {
    {"initialize", nullptr, Initialize, nullptr, nullptr, nullptr, napi_default, tag},
    {"create", nullptr, Create, nullptr, nullptr, nullptr, napi_default, tag},
    {"read", nullptr, Read, nullptr, nullptr, nullptr, napi_default, tag},
    {"remove", nullptr, Remove, nullptr, nullptr, nullptr, napi_default, tag},
    {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, tag}
  };
  if (napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods) != napi_ok || napi_object_freeze(env, exports) != napi_ok)
    return Throw(env, tag, emergency);
  return exports;
}
}  // namespace
NAPI_MODULE(reviewops_remote_device_identity, Module)
