/*
Copyright (c) Microsoft Corporation.
Copyright (c) Season Framework contributors.

Derived from Microsoft's IndirectDisplay sample at
d49bb7d72f3651952b2b6e4ad28d14fe2247eb69 (MS-PL, included in MS-PL.txt).
The D3D initialization, mode timing and swap-chain processing follow that sample.
This uninstalled, unsigned experiment creates no monitor until an admitted IOCTL.
*/
#include "Driver.h"
#include <cstring>

using Microsoft::WRL::ComPtr;
namespace api = reviewops::display;

namespace {
NTSTATUS NewId(GUID& value) {
    const NTSTATUS status = BCryptGenRandom(nullptr, reinterpret_cast<PUCHAR>(&value), sizeof(value), BCRYPT_USE_SYSTEM_PREFERRED_RNG);
    if (NT_SUCCESS(status)) {
        value.Data3 = static_cast<USHORT>((value.Data3 & 0x0fffU) | 0x4000U);
        value.Data4[0] = static_cast<UCHAR>((value.Data4[0] & 0x3fU) | 0x80U);
    }
    return status;
}
bool SameId(const GUID& a, const GUID& b) { return std::memcmp(&a, &b, sizeof(GUID)) == 0; }
bool ValidMode(const api::CreateRequest& value) {
    return value.reserved == 0 && value.refreshHz == 60 &&
        ((value.width == 1920 && value.height == 1080) || (value.width == 3840 && value.height == 2160));
}
void SignalInfo(DISPLAYCONFIG_VIDEO_SIGNAL_INFO& value, UINT width, UINT height, bool monitorMode) {
    value.totalSize.cx = value.activeSize.cx = width;
    value.totalSize.cy = value.activeSize.cy = height;
    value.AdditionalSignalInfo.vSyncFreqDivider = monitorMode ? 0U : 1U;
    value.AdditionalSignalInfo.videoStandard = 255;
    value.vSyncFreq.Numerator = 60; value.vSyncFreq.Denominator = 1;
    value.hSyncFreq.Numerator = 60 * height; value.hSyncFreq.Denominator = 1;
    value.scanLineOrdering = DISPLAYCONFIG_SCANLINE_ORDERING_PROGRESSIVE;
    value.pixelRate = UINT64{60} * width * height;
}
}

// Each lease owns one native reference until departure or device teardown.
// Separate references keep its metadata alive through asynchronous WDF cleanup.
class MonitorLease {
public:
    std::atomic<ULONG> references{1};
    IDDCX_MONITOR monitor = nullptr; // Protected by DeviceState::mutex.
    GUID id{};
    GUID owner{};
    UINT connector = 0, width = 0, height = 0;
    LUID adapterLuid{};
    UINT targetId = 0;
    NTSTATUS removalStatus = STATUS_SUCCESS;
    bool removalUnconfirmed = false, retiring = false;
    void AddRef() { references.fetch_add(1, std::memory_order_relaxed); }
    void Release() { if (references.fetch_sub(1, std::memory_order_acq_rel) == 1) delete this; }
};

class DeviceState {
public:
    explicit DeviceState(WDFDEVICE value) : device(value) {}
    std::atomic<ULONG> references{1};
    std::mutex mutex;
    std::condition_variable changed;
    WDFDEVICE device;
    GUID id{};
    IDDCX_ADAPTER adapter = nullptr;
    bool starting = false, ready = false, stopping = false;
    UINT openFiles = 0, activeDepartures = 0;
    MonitorLease* slots[api::MaximumMonitors]{};
    void AddRef() { references.fetch_add(1, std::memory_order_relaxed); }
    void Release() { if (references.fetch_sub(1, std::memory_order_acq_rel) == 1) delete this; }
    NTSTATUS InitializeAdapter();
    NTSTATUS Create(FileState& file, const api::CreateRequest& input);
    NTSTATUS Remove(FileState& file, const GUID& id);
    void Close(FileState& file);
    void Stop();
    void Describe(const FileState& file, api::Reply& output);
    bool ReserveFile() { std::lock_guard<std::mutex> lock(mutex); if (stopping || openFiles >= 32) return false; ++openFiles; return true; }
    void ReleaseFile() { std::lock_guard<std::mutex> lock(mutex); --openFiles; }
private:
    NTSTATUS Retire(FileState& file, std::unique_lock<std::mutex>& lock);
};

class FileState {
public:
    explicit FileState(DeviceState* value) : device(value) { device->AddRef(); }
    ~FileState() { if (lease) lease->Release(); device->ReleaseFile(); device->Release(); }
    DeviceState* device;
    GUID id{};
    MonitorLease* lease = nullptr; // Protected by device->mutex.
    bool closing = false;
};

// Adapted from the official sample. Frames are acknowledged and discarded;
// this driver does not capture, encode, transmit or inject user-session input.
class SwapChainProcessor {
public:
    SwapChainProcessor(IDDCX_SWAPCHAIN chain, ComPtr<ID3D11Device> device, HANDLE available)
        : chain_(chain), device_(std::move(device)), available_(available) {}
    bool Start() {
        terminate_ = CreateEvent(nullptr, FALSE, FALSE, nullptr);
        if (!terminate_) return false;
        thread_ = CreateThread(nullptr, 0, RunThread, this, 0, nullptr);
        return thread_ != nullptr;
    }
    ~SwapChainProcessor() {
        if (terminate_) SetEvent(terminate_);
        if (thread_) { WaitForSingleObject(thread_, INFINITE); CloseHandle(thread_); }
        if (terminate_) CloseHandle(terminate_);
    }
private:
    static DWORD CALLBACK RunThread(void* value) { static_cast<SwapChainProcessor*>(value)->Run(); return 0; }
    void Run() {
        DWORD task = 0;
        HANDLE scheduler = AvSetMmThreadCharacteristicsW(L"Distribution", &task);
        ComPtr<IDXGIDevice> dxgi;
        HRESULT result = device_.As(&dxgi);
        if (SUCCEEDED(result)) {
            IDARG_IN_SWAPCHAINSETDEVICE input{}; input.pDevice = dxgi.Get();
            result = IddCxSwapChainSetDevice(chain_, &input);
        }
        while (SUCCEEDED(result)) {
            if (WaitForSingleObject(terminate_, 0) == WAIT_OBJECT_0) break;
            IDARG_OUT_RELEASEANDACQUIREBUFFER acquired{};
            result = IddCxSwapChainReleaseAndAcquireBuffer(chain_, &acquired);
            if (result == E_PENDING) {
                HANDLE handles[]{available_, terminate_};
                const DWORD wait = WaitForMultipleObjects(2, handles, FALSE, 16);
                if (wait == WAIT_OBJECT_0 || wait == WAIT_TIMEOUT) { result = S_OK; continue; }
                break;
            }
            if (FAILED(result)) break;
            ComPtr<IDXGIResource> surface; surface.Attach(acquired.MetaData.pSurface);
            surface.Reset();
            result = IddCxSwapChainFinishedProcessingFrame(chain_);
        }
        // As in the sample, delete only this assigned swap-chain on termination.
        WdfObjectDelete(chain_);
        chain_ = nullptr;
        if (scheduler) AvRevertMmThreadCharacteristics(scheduler);
    }
    IDDCX_SWAPCHAIN chain_;
    ComPtr<ID3D11Device> device_;
    HANDLE available_;
    HANDLE terminate_ = nullptr, thread_ = nullptr;
};

namespace {
void MonitorCleanup(WDFOBJECT object) {
    auto* context = GetMonitorContext(object);
    delete context->processor; context->processor = nullptr;
    if (context->lease) { context->lease->Release(); context->lease = nullptr; }
    // This callback never takes DeviceState::mutex: departure can invoke it.
}
void AdapterCleanup(WDFOBJECT object) {
    auto* context = GetAdapterContext(object);
    auto* state = static_cast<DeviceState*>(InterlockedExchangePointer(reinterpret_cast<void* volatile*>(&context->state), nullptr));
    if (state) state->Release();
}
void DeviceDestroy(WDFOBJECT object) {
    auto* context = GetDeviceContext(object);
    if (context->state) { context->state->Release(); context->state = nullptr; }
}
}

NTSTATUS DeviceState::InitializeAdapter() {
    {
        std::lock_guard<std::mutex> lock(mutex);
        if (stopping) return STATUS_DELETE_PENDING;
        if (starting) return STATUS_SUCCESS;
        starting = true;
    }
    IDDCX_ADAPTER_CAPS caps{};
    caps.Size = sizeof(caps); caps.MaxMonitorsSupported = api::MaximumMonitors;
    caps.EndPointDiagnostics.Size = sizeof(caps.EndPointDiagnostics);
    caps.EndPointDiagnostics.GammaSupport = IDDCX_FEATURE_IMPLEMENTATION_NONE;
    caps.EndPointDiagnostics.TransmissionType = IDDCX_TRANSMISSION_TYPE_WIRED_OTHER;
    caps.EndPointDiagnostics.pEndPointFriendlyName = L"ReviewOps isolated prototype";
    caps.EndPointDiagnostics.pEndPointManufacturerName = L"Season Framework";
    caps.EndPointDiagnostics.pEndPointModelName = L"File-owned virtual display experiment";
    IDDCX_ENDPOINT_VERSION version{}; version.Size = sizeof(version); version.MajorVer = 1;
    caps.EndPointDiagnostics.pFirmwareVersion = &version;
    caps.EndPointDiagnostics.pHardwareVersion = &version;
    WDF_OBJECT_ATTRIBUTES attributes;
    WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&attributes, AdapterContext);
    attributes.EvtCleanupCallback = AdapterCleanup;
    IDARG_IN_ADAPTER_INIT input{}; input.WdfDevice = device; input.pCaps = &caps; input.ObjectAttributes = &attributes;
    IDARG_OUT_ADAPTER_INIT output{};
    const NTSTATUS status = IddCxAdapterInitAsync(&input, &output);
    if (NT_SUCCESS(status)) {
        auto* context = GetAdapterContext(output.AdapterObject);
        AddRef(); InterlockedExchangePointer(reinterpret_cast<void* volatile*>(&context->state), this);
        std::lock_guard<std::mutex> lock(mutex); adapter = output.AdapterObject;
        // The async completion may have arrived before the returned context was
        // connected to this state. Its fixed completion flag closes that race.
        if (!stopping && InterlockedCompareExchange(&context->completed, 0, 0)) ready = NT_SUCCESS(context->initializationStatus);
    }
    return status;
}

NTSTATUS DeviceState::Create(FileState& file, const api::CreateRequest& input) {
    std::lock_guard<std::mutex> lock(mutex);
    if (stopping || file.closing) return STATUS_DELETE_PENDING;
    if (!ready || !adapter) return STATUS_DEVICE_NOT_READY;
    if (file.lease) {
        if (file.lease->retiring) return STATUS_DEVICE_BUSY;
        if (file.lease->removalUnconfirmed) return file.lease->removalStatus;
        // Retrying the same mode on this original file returns the original lease.
        return file.lease->width == input.width && file.lease->height == input.height ? STATUS_SUCCESS : STATUS_DEVICE_BUSY;
    }
    UINT connector = 0;
    while (connector < api::MaximumMonitors && slots[connector]) ++connector;
    if (connector == api::MaximumMonitors) return STATUS_INSUFFICIENT_RESOURCES;
    auto* lease = new (std::nothrow) MonitorLease();
    if (!lease) return STATUS_INSUFFICIENT_RESOURCES;
    NTSTATUS status = NewId(lease->id);
    if (!NT_SUCCESS(status)) { lease->Release(); return status; }
    lease->owner = file.id; lease->width = input.width; lease->height = input.height; lease->connector = connector;
    WDF_OBJECT_ATTRIBUTES attributes;
    WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&attributes, MonitorContext);
    attributes.EvtCleanupCallback = MonitorCleanup;
    IDDCX_MONITOR_INFO info{}; info.Size = sizeof(info);
    info.MonitorType = DISPLAYCONFIG_OUTPUT_TECHNOLOGY_HDMI;
    info.ConnectorIndex = connector; info.MonitorContainerId = lease->id;
    info.MonitorDescription.Size = sizeof(info.MonitorDescription);
    info.MonitorDescription.Type = IDDCX_MONITOR_DESCRIPTION_TYPE_EDID;
    info.MonitorDescription.DataSize = 0; info.MonitorDescription.pData = nullptr;
    IDARG_IN_MONITORCREATE create{}; create.ObjectAttributes = &attributes; create.pMonitorInfo = &info;
    IDARG_OUT_MONITORCREATE created{};
    status = IddCxMonitorCreate(adapter, &create, &created);
    if (!NT_SUCCESS(status)) { lease->Release(); return status; }
    lease->monitor = created.MonitorObject;
    lease->AddRef(); GetMonitorContext(created.MonitorObject)->lease = lease;
    WdfObjectReference(created.MonitorObject);
    IDARG_OUT_MONITORARRIVAL arrival{};
    status = IddCxMonitorArrival(created.MonitorObject, &arrival);
    if (!NT_SUCCESS(status)) {
        lease->monitor = nullptr;
        // A never-arrived object is deleted directly, unlike successful departure.
        WdfObjectDelete(created.MonitorObject); WdfObjectDereference(created.MonitorObject);
        lease->Release(); return status;
    }
    lease->adapterLuid = arrival.OsAdapterLuid; lease->targetId = arrival.OsTargetId;
    lease->AddRef(); slots[connector] = lease;
    file.lease = lease; // Transfer the creator's reference to this exact file.
    return STATUS_SUCCESS;
}

NTSTATUS DeviceState::Retire(FileState& file, std::unique_lock<std::mutex>& lock) {
    changed.wait(lock, [&file] { return !file.lease || !file.lease->retiring; });
    auto* lease = file.lease;
    if (!lease) return STATUS_SUCCESS;
    if (lease->removalUnconfirmed) return lease->removalStatus;
    const IDDCX_MONITOR monitor = lease->monitor;
    if (monitor) {
        // Detach before calling IddCx; successful departure destroys the object.
        lease->monitor = nullptr; lease->retiring = true; lease->AddRef(); ++activeDepartures;
        lock.unlock();
        const NTSTATUS status = IddCxMonitorDeparture(monitor);
        if (NT_SUCCESS(status)) WdfObjectDereference(monitor);
        // Departure/unassign/worker joins and WDF cleanup run without the map lock.
        lock.lock();
        --activeDepartures; lease->retiring = false; changed.notify_all();
        if (!NT_SUCCESS(status)) {
            // Keep the original reference and connector reserved. No blind replay.
            lease->monitor = monitor; lease->removalUnconfirmed = true; lease->removalStatus = status;
            lease->Release();
            return status;
        }
        lease->Release();
    }
    if (slots[lease->connector] == lease) { slots[lease->connector] = nullptr; lease->Release(); }
    file.lease = nullptr; lease->Release();
    return STATUS_SUCCESS;
}
NTSTATUS DeviceState::Remove(FileState& file, const GUID& idToRemove) {
    std::unique_lock<std::mutex> lock(mutex);
    if (stopping || file.closing) return STATUS_DELETE_PENDING;
    if (!file.lease || !SameId(file.lease->id, idToRemove) || !SameId(file.lease->owner, file.id)) return STATUS_ACCESS_DENIED;
    if (file.lease->retiring) return STATUS_DEVICE_BUSY;
    return Retire(file, lock);
}
void DeviceState::Close(FileState& file) {
    std::unique_lock<std::mutex> lock(mutex);
    if (file.closing) return;
    file.closing = true;
    if (!stopping) (void)Retire(file, lock);
    // A failed departure stays reserved in this device's slot until teardown.
    if (file.lease) { file.lease->Release(); file.lease = nullptr; }
}
void DeviceState::Stop() {
    std::unique_lock<std::mutex> lock(mutex);
    if (stopping) return;
    stopping = true; ready = false;
    changed.wait(lock, [this] { return activeDepartures == 0; });
    // PnP owns adapter/monitor destruction here. Release only our retained refs.
    for (auto*& lease : slots) {
        if (!lease) continue;
        const IDDCX_MONITOR monitor = lease->monitor; lease->monitor = nullptr;
        if (monitor) { lock.unlock(); WdfObjectDereference(monitor); lock.lock(); }
        lease->Release(); lease = nullptr;
    }
}
void DeviceState::Describe(const FileState& file, api::Reply& output) {
    output = {}; output.header = {sizeof(output), api::ProtocolVersion}; output.deviceId = id; output.fileOwnerId = file.id;
    output.connectorIndex = UINT32_MAX;
    output.state = stopping ? api::State::DeviceStopping : file.closing ? api::State::FileClosing : ready ? api::State::Empty : api::State::AdapterNotReady;
    if (file.lease) {
        const auto& lease = *file.lease;
        output.monitorId = lease.id; output.connectorIndex = lease.connector;
        output.width = lease.width; output.height = lease.height; output.refreshHz = 60;
        output.adapterLuidLow = lease.adapterLuid.LowPart; output.adapterLuidHigh = lease.adapterLuid.HighPart; output.osTargetId = lease.targetId;
        output.nativeStatus = static_cast<uint32_t>(lease.removalStatus);
        if (!stopping && !file.closing) output.state = lease.removalUnconfirmed ? api::State::RemovalUnconfirmed : api::State::Attached;
    }
}

extern "C" BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, void* reserved) {
    UNREFERENCED_PARAMETER(instance); UNREFERENCED_PARAMETER(reason); UNREFERENCED_PARAMETER(reserved); return TRUE;
}
_Use_decl_annotations_
extern "C" NTSTATUS DriverEntry(PDRIVER_OBJECT driver, PUNICODE_STRING registry) {
    WDF_DRIVER_CONFIG config; WDF_DRIVER_CONFIG_INIT(&config, ReviewOpsDeviceAdd);
    return WdfDriverCreate(driver, registry, WDF_NO_OBJECT_ATTRIBUTES, &config, WDF_NO_HANDLE);
}
_Use_decl_annotations_
NTSTATUS ReviewOpsDeviceAdd(WDFDRIVER driver, PWDFDEVICE_INIT init) {
    UNREFERENCED_PARAMETER(driver);
    WDF_PNPPOWER_EVENT_CALLBACKS power; WDF_PNPPOWER_EVENT_CALLBACKS_INIT(&power); power.EvtDeviceD0Entry = ReviewOpsD0Entry;
    WdfDeviceInitSetPnpPowerEventCallbacks(init, &power);
    // UMDF uses the INF's per-device Security and DeviceCharacteristics settings.
    // WdfDeviceInitSetCharacteristics is a KMDF-only API.
    WDF_FILEOBJECT_CONFIG files; WDF_FILEOBJECT_CONFIG_INIT(&files, ReviewOpsFileCreate, ReviewOpsFileClose, ReviewOpsFileCleanup);
    WDF_OBJECT_ATTRIBUTES fileAttributes; WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&fileAttributes, FileContext);
    fileAttributes.SynchronizationScope = WdfSynchronizationScopeNone; fileAttributes.ExecutionLevel = WdfExecutionLevelPassive;
    WdfDeviceInitSetFileObjectConfig(init, &files, &fileAttributes);
    IDD_CX_CLIENT_CONFIG client; IDD_CX_CLIENT_CONFIG_INIT(&client);
    // IddCx routes custom IOCTLs through this callback, not a default WDF queue.
    client.EvtIddCxDeviceIoControl = ReviewOpsIoControl;
    client.EvtIddCxAdapterInitFinished = ReviewOpsAdapterReady; client.EvtIddCxAdapterCommitModes = ReviewOpsCommitModes;
    client.EvtIddCxParseMonitorDescription = ReviewOpsParseDescription;
    client.EvtIddCxMonitorGetDefaultDescriptionModes = ReviewOpsDefaultModes; client.EvtIddCxMonitorQueryTargetModes = ReviewOpsTargetModes;
    client.EvtIddCxMonitorAssignSwapChain = ReviewOpsAssignSwapChain; client.EvtIddCxMonitorUnassignSwapChain = ReviewOpsUnassignSwapChain;
    NTSTATUS status = IddCxDeviceInitConfig(init, &client); if (!NT_SUCCESS(status)) return status;
    WDF_OBJECT_ATTRIBUTES attributes; WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&attributes, DeviceContext);
    attributes.ExecutionLevel = WdfExecutionLevelPassive; attributes.SynchronizationScope = WdfSynchronizationScopeNone;
    attributes.EvtCleanupCallback = ReviewOpsDeviceCleanup; attributes.EvtDestroyCallback = DeviceDestroy;
    WDFDEVICE device = nullptr;
    status = WdfDeviceCreate(&init, &attributes, &device); if (!NT_SUCCESS(status)) return status;
    auto* state = new (std::nothrow) DeviceState(device); if (!state) return STATUS_INSUFFICIENT_RESOURCES;
    GetDeviceContext(device)->state = state;
    status = NewId(state->id); if (!NT_SUCCESS(status)) return status;
    status = IddCxDeviceInitialize(device); if (!NT_SUCCESS(status)) return status;
    return WdfDeviceCreateDeviceInterface(device, &api::InterfaceId, nullptr);
}
_Use_decl_annotations_
NTSTATUS ReviewOpsD0Entry(WDFDEVICE device, WDF_POWER_DEVICE_STATE previous) {
    UNREFERENCED_PARAMETER(previous); return GetDeviceContext(device)->state->InitializeAdapter();
}
_Use_decl_annotations_
void ReviewOpsDeviceCleanup(WDFOBJECT object) { auto* state = GetDeviceContext(object)->state; if (state) state->Stop(); }
_Use_decl_annotations_
void ReviewOpsFileCreate(WDFDEVICE device, WDFREQUEST request, WDFFILEOBJECT file) {
    auto* state = GetDeviceContext(device)->state;
    const auto* name = WdfFileObjectGetFileName(file);
    if (!state || (name && name->Length != 0)) { WdfRequestComplete(request, STATUS_ACCESS_DENIED); return; }
    if (!state->ReserveFile()) { WdfRequestComplete(request, STATUS_INSUFFICIENT_RESOURCES); return; }
    auto* owner = new (std::nothrow) FileState(state);
    if (!owner) { state->ReleaseFile(); WdfRequestComplete(request, STATUS_INSUFFICIENT_RESOURCES); return; }
    NTSTATUS status = NewId(owner->id);
    { std::lock_guard<std::mutex> lock(state->mutex); if (state->stopping) status = STATUS_DELETE_PENDING; }
    if (!NT_SUCCESS(status)) { delete owner; WdfRequestComplete(request, status); return; }
    GetFileContext(file)->state = owner; WdfRequestComplete(request, STATUS_SUCCESS);
}
_Use_decl_annotations_
void ReviewOpsFileCleanup(WDFFILEOBJECT file) { auto* owner = GetFileContext(file)->state; if (owner) owner->device->Close(*owner); }
_Use_decl_annotations_
void ReviewOpsFileClose(WDFFILEOBJECT file) {
    auto* context = GetFileContext(file);
    if (context->state) { context->state->device->Close(*context->state); delete context->state; context->state = nullptr; }
}
_Use_decl_annotations_
void ReviewOpsIoControl(WDFDEVICE device, WDFREQUEST request, size_t outputLength, size_t inputLength, ULONG code) {
    auto* state = GetDeviceContext(device)->state; const WDFFILEOBJECT file = WdfRequestGetFileObject(request);
    if (!state || !file || !GetFileContext(file)->state || GetFileContext(file)->state->device != state) { WdfRequestComplete(request, STATUS_ACCESS_DENIED); return; }
    const size_t expected = code == api::Query ? sizeof(api::Header) : code == api::Create ? sizeof(api::CreateRequest) : code == api::Remove ? sizeof(api::RemoveRequest) : 0;
    if (!expected) { WdfRequestComplete(request, STATUS_INVALID_DEVICE_REQUEST); return; }
    if (inputLength != expected || outputLength != sizeof(api::Reply)) { WdfRequestComplete(request, STATUS_INFO_LENGTH_MISMATCH); return; }
    void* input = nullptr; api::Reply* output = nullptr;
    NTSTATUS status = WdfRequestRetrieveInputBuffer(request, expected, &input, nullptr);
    if (NT_SUCCESS(status)) status = WdfRequestRetrieveOutputBuffer(request, sizeof(*output), reinterpret_cast<void**>(&output), nullptr);
    if (!NT_SUCCESS(status)) { WdfRequestComplete(request, status); return; }
    const api::Header header = *static_cast<const api::Header*>(input);
    if (header.size != expected || header.version != api::ProtocolVersion) { WdfRequestComplete(request, STATUS_REVISION_MISMATCH); return; }
    // METHOD_BUFFERED can alias input/output; snapshot before writing the reply.
    api::CreateRequest create{}; api::RemoveRequest remove{};
    if (code == api::Create) { create = *static_cast<const api::CreateRequest*>(input); if (!ValidMode(create)) { WdfRequestComplete(request, STATUS_INVALID_PARAMETER); return; } }
    if (code == api::Remove) { remove = *static_cast<const api::RemoveRequest*>(input); if (remove.reserved[0] || remove.reserved[1]) { WdfRequestComplete(request, STATUS_INVALID_PARAMETER); return; } }
    auto& owner = *GetFileContext(file)->state;
    if (code == api::Create) status = state->Create(owner, create);
    else if (code == api::Remove) status = state->Remove(owner, remove.monitorId);
    else status = STATUS_SUCCESS;
    { std::lock_guard<std::mutex> lock(state->mutex);
      if (owner.closing || state->stopping) status = STATUS_DELETE_PENDING;
      if (NT_SUCCESS(status)) state->Describe(owner, *output); }
    WdfRequestCompleteWithInformation(request, status, NT_SUCCESS(status) ? sizeof(*output) : 0);
}

_Use_decl_annotations_
NTSTATUS ReviewOpsAdapterReady(IDDCX_ADAPTER adapter, const IDARG_IN_ADAPTER_INIT_FINISHED* input) {
    auto* context = GetAdapterContext(adapter);
    context->initializationStatus = input->AdapterInitStatus;
    InterlockedExchange(&context->completed, 1);
    auto* state = static_cast<DeviceState*>(InterlockedCompareExchangePointer(reinterpret_cast<void* volatile*>(&context->state), nullptr, nullptr));
    if (!state) return STATUS_SUCCESS;
    std::lock_guard<std::mutex> lock(state->mutex);
    if (!state->stopping) state->ready = NT_SUCCESS(input->AdapterInitStatus);
    return STATUS_SUCCESS;
}
_Use_decl_annotations_
NTSTATUS ReviewOpsCommitModes(IDDCX_ADAPTER adapter, const IDARG_IN_COMMITMODES* input) {
    UNREFERENCED_PARAMETER(adapter); UNREFERENCED_PARAMETER(input); return STATUS_SUCCESS;
}
_Use_decl_annotations_
NTSTATUS ReviewOpsParseDescription(const IDARG_IN_PARSEMONITORDESCRIPTION* input, IDARG_OUT_PARSEMONITORDESCRIPTION* output) {
    UNREFERENCED_PARAMETER(input); UNREFERENCED_PARAMETER(output); return STATUS_NOT_SUPPORTED;
}
_Use_decl_annotations_
NTSTATUS ReviewOpsDefaultModes(IDDCX_MONITOR monitor, const IDARG_IN_GETDEFAULTDESCRIPTIONMODES* input, IDARG_OUT_GETDEFAULTDESCRIPTIONMODES* output) {
    const auto* lease = GetMonitorContext(monitor)->lease; if (!lease) return STATUS_DEVICE_NOT_READY;
    output->DefaultMonitorModeBufferOutputCount = 1; output->PreferredMonitorModeIdx = 0;
    if (!input->DefaultMonitorModeBufferInputCount) return STATUS_SUCCESS;
    if (!input->pDefaultMonitorModes) return STATUS_INVALID_PARAMETER;
    IDDCX_MONITOR_MODE mode{}; mode.Size = sizeof(mode); mode.Origin = IDDCX_MONITOR_MODE_ORIGIN_DRIVER;
    SignalInfo(mode.MonitorVideoSignalInfo, lease->width, lease->height, true); input->pDefaultMonitorModes[0] = mode;
    return STATUS_SUCCESS;
}
_Use_decl_annotations_
NTSTATUS ReviewOpsTargetModes(IDDCX_MONITOR monitor, const IDARG_IN_QUERYTARGETMODES* input, IDARG_OUT_QUERYTARGETMODES* output) {
    const auto* lease = GetMonitorContext(monitor)->lease; if (!lease) return STATUS_DEVICE_NOT_READY;
    output->TargetModeBufferOutputCount = 1;
    if (!input->TargetModeBufferInputCount) return STATUS_SUCCESS;
    if (!input->pTargetModes) return STATUS_INVALID_PARAMETER;
    IDDCX_TARGET_MODE mode{}; mode.Size = sizeof(mode);
    SignalInfo(mode.TargetVideoSignalInfo.targetVideoSignalInfo, lease->width, lease->height, false); input->pTargetModes[0] = mode;
    return STATUS_SUCCESS;
}
_Use_decl_annotations_
NTSTATUS ReviewOpsAssignSwapChain(IDDCX_MONITOR monitor, const IDARG_IN_SETSWAPCHAIN* input) {
    auto* context = GetMonitorContext(monitor); delete context->processor; context->processor = nullptr;
    ComPtr<IDXGIFactory5> factory; ComPtr<IDXGIAdapter1> adapter; ComPtr<ID3D11Device> device;
    HRESULT status = CreateDXGIFactory2(0, IID_PPV_ARGS(&factory));
    if (SUCCEEDED(status)) status = factory->EnumAdapterByLuid(input->RenderAdapterLuid, IID_PPV_ARGS(&adapter));
    if (SUCCEEDED(status)) status = D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &device, nullptr, nullptr);
    if (FAILED(status)) { WdfObjectDelete(input->hSwapChain); return STATUS_SUCCESS; }
    context->processor = new (std::nothrow) SwapChainProcessor(input->hSwapChain, std::move(device), input->hNextSurfaceAvailable);
    if (!context->processor || !context->processor->Start()) {
        delete context->processor; context->processor = nullptr; WdfObjectDelete(input->hSwapChain);
    }
    return STATUS_SUCCESS;
}
_Use_decl_annotations_
NTSTATUS ReviewOpsUnassignSwapChain(IDDCX_MONITOR monitor) {
    auto* context = GetMonitorContext(monitor); delete context->processor; context->processor = nullptr; return STATUS_SUCCESS;
}
