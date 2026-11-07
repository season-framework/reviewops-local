// Copyright (c) Season Framework contributors.
// Build-only prototype client. No installation, elevation or device activation.
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <Windows.h>
#include <SetupAPI.h>
#include "ControlProtocol.h"
#include <array>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <iostream>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#pragma comment(lib, "Setupapi.lib")
namespace api = reviewops::display;
namespace {
constexpr DWORD IoTimeoutMs = 5000, CancelDrainMs = 2000;
constexpr size_t MaximumInterfaces = 64, MaximumLine = 128, MaximumCommands = 64;
constexpr const char* Scope = "build-only-virtual-display-prototype";
constexpr const char* InterfaceText = "54af4a35-1a70-4d76-90ef-83c8aa237bb3";

struct Refusal { const char* code; DWORD win32; };
[[noreturn]] void Refuse(const char* code, DWORD win32 = ERROR_SUCCESS) { throw Refusal{code, win32}; }
std::string Json(const std::string& text) {
    std::string result = "\"";
    constexpr char hex[] = "0123456789abcdef";
    for (const char value : text) {
        const auto c = static_cast<unsigned char>(value);
        if (c == '"' || c == '\\') { result += '\\'; result += value; }
        else if (c < 0x20U || c == 0x7fU) { result += "\\u00"; result += hex[c >> 4U]; result += hex[c & 15U]; }
        else result += value;
    }
    return result + '"';
}
std::string Utf8(const std::wstring& text) {
    if (text.empty() || text.size() > 4096) Refuse("INSTANCE_ID_REFUSED");
    const int length = static_cast<int>(text.size());
    const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), length, nullptr, 0, nullptr, nullptr);
    if (bytes <= 0) Refuse("INSTANCE_ID_REFUSED", GetLastError());
    std::string result(static_cast<size_t>(bytes), '\0');
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), length, result.data(), bytes, nullptr, nullptr) != bytes)
        Refuse("INSTANCE_ID_REFUSED", GetLastError());
    return result;
}
bool Same(const GUID& a, const GUID& b) { return std::memcmp(&a, &b, sizeof(GUID)) == 0; }
bool Zero(const GUID& value) { const GUID zero{}; return Same(value, zero); }
bool RandomId(const GUID& value) { return !Zero(value) && (value.Data3 & 0xf000U) == 0x4000U && (value.Data4[0] & 0xc0U) == 0x80U; }
std::string Guid(const GUID& value) {
    char text[37]{};
    const int size = std::snprintf(text, sizeof(text), "%08x-%04x-%04x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        static_cast<unsigned int>(value.Data1), static_cast<unsigned int>(value.Data2), static_cast<unsigned int>(value.Data3),
        static_cast<unsigned int>(value.Data4[0]), static_cast<unsigned int>(value.Data4[1]), static_cast<unsigned int>(value.Data4[2]),
        static_cast<unsigned int>(value.Data4[3]), static_cast<unsigned int>(value.Data4[4]), static_cast<unsigned int>(value.Data4[5]),
        static_cast<unsigned int>(value.Data4[6]), static_cast<unsigned int>(value.Data4[7]));
    if (size != 36) Refuse("IDENTITY_FORMAT_REFUSED");
    return text;
}
void Error(const char* operation, const char* code, DWORD win32 = ERROR_SUCCESS) {
    std::cout << "{\"schema\":1,\"scope\":" << Json(Scope) << ",\"operation\":" << Json(operation)
        << ",\"ok\":false,\"error\":" << Json(code) << ",\"win32Error\":" << win32 << "}" << std::endl;
}
struct Handle {
    HANDLE value = INVALID_HANDLE_VALUE;
    explicit Handle(HANDLE input = INVALID_HANDLE_VALUE) : value(input) {}
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    ~Handle() { (void)Close(); }
    bool Close() {
        if (value == INVALID_HANDLE_VALUE || value == nullptr) return true;
        const HANDLE original = value; value = INVALID_HANDLE_VALUE;
        return CloseHandle(original) != FALSE;
    }
};
struct DeviceSet {
    HDEVINFO value = INVALID_HANDLE_VALUE;
    ~DeviceSet() { if (value != INVALID_HANDLE_VALUE) SetupDiDestroyDeviceInfoList(value); }
};
struct Interface { std::wstring instance, path; bool active; };
std::vector<Interface> Enumerate() {
    DeviceSet set;
    set.value = SetupDiGetClassDevsW(&api::InterfaceId, nullptr, nullptr, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
    if (set.value == INVALID_HANDLE_VALUE) Refuse("ENUMERATION_FAILED", GetLastError());
    std::vector<Interface> result;
    for (DWORD index = 0;; ++index) {
        SP_DEVICE_INTERFACE_DATA entry{}; entry.cbSize = static_cast<DWORD>(sizeof(entry));
        if (!SetupDiEnumDeviceInterfaces(set.value, nullptr, &api::InterfaceId, index, &entry)) {
            const DWORD error = GetLastError();
            if (error == ERROR_NO_MORE_ITEMS) break;
            Refuse("ENUMERATION_FAILED", error);
        }
        if (result.size() >= MaximumInterfaces) Refuse("ENUMERATION_LIMIT");
        DWORD bytes = 0;
        if (SetupDiGetDeviceInterfaceDetailW(set.value, &entry, nullptr, 0, &bytes, nullptr) || GetLastError() != ERROR_INSUFFICIENT_BUFFER ||
            bytes < sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W) || bytes > 65536) Refuse("INTERFACE_DETAIL_REFUSED");
        // DWORD storage provides alignment for the SDK's variable-length struct.
        std::vector<DWORD> storage((static_cast<size_t>(bytes) + sizeof(DWORD) - 1) / sizeof(DWORD), 0);
        auto* detail = reinterpret_cast<SP_DEVICE_INTERFACE_DETAIL_DATA_W*>(storage.data()); detail->cbSize = static_cast<DWORD>(sizeof(*detail));
        SP_DEVINFO_DATA device{}; device.cbSize = static_cast<DWORD>(sizeof(device));
        if (!SetupDiGetDeviceInterfaceDetailW(set.value, &entry, detail, bytes, nullptr, &device)) Refuse("INTERFACE_DETAIL_REFUSED", GetLastError());
        const size_t capacity = (static_cast<size_t>(bytes) - offsetof(SP_DEVICE_INTERFACE_DETAIL_DATA_W, DevicePath)) / sizeof(wchar_t);
        size_t length = 0; while (length < capacity && detail->DevicePath[length]) ++length;
        if (!length || length == capacity) Refuse("INTERFACE_DETAIL_REFUSED");
        std::array<wchar_t, 4096> instance{}; DWORD required = 0;
        if (!SetupDiGetDeviceInstanceIdW(set.value, &device, instance.data(), static_cast<DWORD>(instance.size()), &required))
            Refuse("INSTANCE_ID_REFUSED", GetLastError());
        if (required < 2 || static_cast<size_t>(required) > instance.size() || instance[required - 1] != L'\0') Refuse("INSTANCE_ID_REFUSED");
        std::wstring identity(instance.data(), static_cast<size_t>(required - 1));
        (void)Utf8(identity);
        result.push_back({std::move(identity), std::wstring(detail->DevicePath, length), (entry.Flags & SPINT_ACTIVE) != 0 && (entry.Flags & SPINT_REMOVED) == 0});
    }
    return result;
}
void List(const std::vector<Interface>& devices) {
    std::cout << "{\"schema\":1,\"scope\":" << Json(Scope) << ",\"operation\":\"list\",\"ok\":true,\"interfaceClass\":" << Json(InterfaceText)
        << ",\"availability\":" << Json(devices.empty() ? "not-enumerated" : "interface-present-control-not-probed") << ",\"devices\":[";
    bool first = true;
    for (const auto& device : devices) {
        if (!first) std::cout << ',';
        first = false;
        std::cout << "{\"instanceId\":" << Json(Utf8(device.instance)) << ",\"interfaceActive\":" << (device.active ? "true" : "false") << '}';
    }
    std::cout << "],\"deviceOpened\":false,\"displayChangeRequested\":false}" << std::endl;
}

// Heap ownership includes every buffer/event the kernel can still reference.
struct PendingIo {
    OVERLAPPED overlapped{};
    std::array<unsigned char, sizeof(api::CreateRequest) + sizeof(api::RemoveRequest)> input{};
    api::Reply output{};
    ~PendingIo() { if (overlapped.hEvent) CloseHandle(overlapped.hEvent); }
};
struct IoResult { bool success; bool completionUnconfirmed; DWORD error; api::Reply reply; };
IoResult Io(HANDLE file, ULONG code, const void* input, DWORD size) {
    auto pending = std::make_unique<PendingIo>();
    if (size > pending->input.size()) Refuse("REQUEST_SIZE_REFUSED");
    std::memcpy(pending->input.data(), input, size);
    pending->overlapped.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!pending->overlapped.hEvent) Refuse("IO_EVENT_FAILED", GetLastError());
    DWORD bytes = 0;
    const BOOL started = DeviceIoControl(file, code, pending->input.data(), size, &pending->output,
        static_cast<DWORD>(sizeof(pending->output)), &bytes, &pending->overlapped);
    DWORD error = started ? ERROR_SUCCESS : GetLastError();
    if (!started && error != ERROR_IO_PENDING) return {false, false, error, {}};
    if (!GetOverlappedResultEx(file, &pending->overlapped, &bytes, IoTimeoutMs, FALSE)) {
        error = GetLastError();
        if (HasOverlappedIoCompleted(&pending->overlapped)) return {false, false, error, {}};
        // A cancellation request is not completion or monitor removal evidence.
        (void)CancelIoEx(file, &pending->overlapped);
        const BOOL drained = GetOverlappedResultEx(file, &pending->overlapped, &bytes, CancelDrainMs, FALSE);
        if (!drained && !HasOverlappedIoCompleted(&pending->overlapped)) {
            // Deliberately retain kernel-referenced memory/event until process
            // exit. The caller stops all commands and closes only its own file.
            (void)pending.release();
            return {false, true, WAIT_TIMEOUT, {}};
        }
        return {false, false, WAIT_TIMEOUT, {}}; // Never replay a timed-out request.
    }
    if (bytes != sizeof(api::Reply)) Refuse("REPLY_SIZE_REFUSED");
    return {true, false, ERROR_SUCCESS, pending->output};
}
const char* StateName(api::State state) {
    switch (state) {
    case api::State::AdapterNotReady: return "adapter-not-ready";
    case api::State::Empty: return "empty";
    case api::State::Attached: return "attached";
    case api::State::RemovalUnconfirmed: return "removal-unconfirmed";
    case api::State::FileClosing: return "file-closing";
    case api::State::DeviceStopping: return "device-stopping";
    default: Refuse("REPLY_STATE_REFUSED");
    }
}
struct Binding { GUID device{}, owner{}, monitor{}; bool pinned = false, blocked = false; uint32_t width = 0, height = 0; };
void Validate(const api::Reply& reply, Binding& binding) {
    if (reply.header.size != sizeof(reply) || reply.header.version != api::ProtocolVersion || reply.reserved != 0 ||
        !RandomId(reply.deviceId) || !RandomId(reply.fileOwnerId) || Same(reply.deviceId, reply.fileOwnerId)) Refuse("REPLY_BINDING_REFUSED");
    (void)StateName(reply.state);
    if (binding.pinned && (!Same(binding.device, reply.deviceId) || !Same(binding.owner, reply.fileOwnerId))) Refuse("ORIGINAL_FILE_BINDING_CHANGED");
    const bool monitor = !Zero(reply.monitorId);
    if (monitor) {
        if (!RandomId(reply.monitorId) || Same(reply.monitorId, reply.deviceId) || Same(reply.monitorId, reply.fileOwnerId) || reply.connectorIndex >= api::MaximumMonitors || reply.refreshHz != 60 ||
            !((reply.width == 1920 && reply.height == 1080) || (reply.width == 3840 && reply.height == 2160))) Refuse("REPLY_MONITOR_REFUSED");
        if (reply.state == api::State::Empty || reply.state == api::State::AdapterNotReady) Refuse("REPLY_STATE_REFUSED");
    } else if (reply.connectorIndex != UINT32_MAX || reply.width || reply.height || reply.refreshHz || reply.nativeStatus ||
        reply.adapterLuidLow || reply.adapterLuidHigh || reply.osTargetId || reply.state == api::State::Attached || reply.state == api::State::RemovalUnconfirmed) Refuse("REPLY_MONITOR_REFUSED");
    if ((reply.state == api::State::Attached && reply.nativeStatus != 0) || (reply.state == api::State::RemovalUnconfirmed && reply.nativeStatus == 0))
        Refuse("REPLY_NATIVE_STATUS_REFUSED");
    if (!binding.pinned) { binding.device = reply.deviceId; binding.owner = reply.fileOwnerId; binding.pinned = true; }
}
void Print(const char* operation, const api::Reply& reply, bool blocked) {
    const bool monitor = !Zero(reply.monitorId);
    std::cout << "{\"schema\":1,\"scope\":" << Json(Scope) << ",\"operation\":" << Json(operation) << ",\"ok\":true,\"protocolVersion\":" << api::ProtocolVersion
        << ",\"deviceId\":" << Json(Guid(reply.deviceId)) << ",\"fileOwnerId\":" << Json(Guid(reply.fileOwnerId)) << ",\"state\":" << Json(StateName(reply.state))
        << ",\"monitorId\":" << (monitor ? Json(Guid(reply.monitorId)) : "null") << ",\"width\":" << reply.width << ",\"height\":" << reply.height << ",\"refreshHz\":" << reply.refreshHz
        << ",\"nativeStatus\":" << reply.nativeStatus << ",\"connectorIndex\":" << (monitor ? std::to_string(reply.connectorIndex) : "null")
        << ",\"adapterLuid\":" << (monitor ? "{\"low\":" + std::to_string(reply.adapterLuidLow) + ",\"high\":" + std::to_string(reply.adapterLuidHigh) + "}" : "null")
        << ",\"osTargetId\":" << (monitor ? std::to_string(reply.osTargetId) : "null") << ",\"mutationsBlocked\":" << (blocked ? "true" : "false") << "}" << std::endl;
}
enum class Line { Complete, End, Refused };
Line ReadCommand(std::string& result) {
    result.clear(); char value = 0;
    while (std::cin.get(value)) {
        if (value == '\n') { if (!result.empty() && result.back() == '\r') result.pop_back(); return Line::Complete; }
        if (result.size() >= MaximumLine || (static_cast<unsigned char>(value) < 0x20U && value != '\r') || static_cast<unsigned char>(value) > 0x7eU) return Line::Refused;
        result += value;
    }
    return result.empty() && !std::cin.bad() ? Line::End : Line::Refused;
}
int Control(const Interface& selected) {
    Handle file(CreateFileW(selected.path.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED, nullptr));
    if (file.value == INVALID_HANDLE_VALUE) Refuse("ORIGINAL_DEVICE_OPEN_FAILED", GetLastError());
    Binding binding; bool failed = false;
    try {
        const api::Header query{sizeof(api::Header), api::ProtocolVersion};
        const IoResult initial = Io(file.value, api::Query, &query, sizeof(query));
        if (!initial.success) Refuse(initial.completionUnconfirmed ? "IO_COMPLETION_UNCONFIRMED" : "INITIAL_QUERY_FAILED", initial.error);
        Validate(initial.reply, binding);
        // Only a successful explicit CREATE below can make a GUID removable.
        if (!Zero(initial.reply.monitorId)) Refuse("INITIAL_FILE_ALREADY_HAS_MONITOR");
        binding.blocked = initial.reply.state == api::State::DeviceStopping || initial.reply.state == api::State::FileClosing;
        Print("open", initial.reply, binding.blocked);
        size_t count = 0;
        for (; count < MaximumCommands; ++count) {
            std::string command;
            const Line line = ReadCommand(command);
            if (line == Line::End || (line == Line::Complete && command == "quit")) break;
            if (line == Line::Refused) { Error("command", "COMMAND_LINE_REFUSED"); failed = true; break; }
            const bool create = command == "create1080" || command == "create4k", remove = command == "remove";
            if (command != "status" && !create && !remove) { Error("command", "UNKNOWN_COMMAND"); failed = true; continue; }
            if ((create || remove) && binding.blocked) { Error(command.c_str(), "MUTATIONS_BLOCKED_OBSERVE_OR_QUIT"); failed = true; continue; }
            if (create && !Zero(binding.monitor)) { Error(command.c_str(), "ORIGINAL_MONITOR_ALREADY_OWNED"); failed = true; continue; }
            if (remove && Zero(binding.monitor)) { Error("remove", "NO_SUCCESSFUL_CREATE_TO_REMOVE"); failed = true; continue; }
            api::CreateRequest request{{sizeof(api::CreateRequest), api::ProtocolVersion}, command == "create4k" ? 3840U : 1920U, command == "create4k" ? 2160U : 1080U, 60U, 0U};
            api::RemoveRequest removal{{sizeof(api::RemoveRequest), api::ProtocolVersion}, binding.monitor, {0U, 0U}};
            const IoResult result = create ? Io(file.value, api::Create, &request, sizeof(request)) : remove ? Io(file.value, api::Remove, &removal, sizeof(removal)) : Io(file.value, api::Query, &query, sizeof(query));
            if (!result.success) {
                Error(command.c_str(), result.completionUnconfirmed ? "IO_COMPLETION_UNCONFIRMED_NO_REPLAY" : "IO_FAILED_OBSERVE_NO_REPLAY", result.error);
                binding.blocked = true; failed = true;
                if (result.completionUnconfirmed) break;
                continue;
            }
            Validate(result.reply, binding);
            if (create) {
                if (result.reply.state != api::State::Attached || result.reply.width != request.width || result.reply.height != request.height || Zero(result.reply.monitorId)) Refuse("CREATE_RESULT_REFUSED");
                binding.monitor = result.reply.monitorId; binding.width = request.width; binding.height = request.height;
            } else if (remove) {
                if (result.reply.state != api::State::Empty || !Zero(result.reply.monitorId)) Refuse("REMOVE_RESULT_UNCONFIRMED");
                binding.monitor = {}; binding.width = binding.height = 0;
            } else if (!Same(result.reply.monitorId, binding.monitor) || (!Zero(binding.monitor) && (result.reply.width != binding.width || result.reply.height != binding.height))) {
                Refuse("ORIGINAL_MONITOR_BINDING_CHANGED");
            }
            if (result.reply.state == api::State::RemovalUnconfirmed || result.reply.state == api::State::DeviceStopping || result.reply.state == api::State::FileClosing) binding.blocked = true;
            Print(command.c_str(), result.reply, binding.blocked);
        }
        if (count == MaximumCommands) { Error("command", "SESSION_COMMAND_LIMIT"); failed = true; }
    } catch (const Refusal& error) { Error("control", error.code, error.win32); failed = true; }
      catch (...) { Error("control", "CONTROL_FAILED"); failed = true; }
    const bool closed = file.Close();
    std::cout << "{\"schema\":1,\"scope\":" << Json(Scope) << ",\"operation\":\"close\",\"fileHandleClosed\":" << (closed ? "true" : "false")
        << ",\"monitorRemovalConfirmed\":false,\"message\":\"Handle closure requests only this file's driver cleanup; physical departure is not certified.\"}" << std::endl;
    return failed || !closed ? 2 : 0;
}
}
int wmain(int argc, wchar_t** argv) {
    try {
        if (argc == 2 && std::wcscmp(argv[1], L"--list") == 0) { List(Enumerate()); return 0; }
        if (argc == 3 && std::wcscmp(argv[1], L"--control") == 0) {
            const std::wstring requested(argv[2]);
            if (requested.empty() || requested.size() > 4096) Refuse("EXACT_INSTANCE_ID_REQUIRED");
            const auto devices = Enumerate(); const Interface* selected = nullptr;
            for (const auto& device : devices) if (device.instance == requested) {
                if (selected) Refuse("AMBIGUOUS_DEVICE_INSTANCE");
                selected = &device;
            }
            if (!selected || !selected->active) Refuse("SELECTED_INTERFACE_UNAVAILABLE");
            return Control(*selected);
        }
        Error("arguments", "USE_LIST_OR_CONTROL_EXACT_INSTANCE_ID"); return 2;
    } catch (const Refusal& error) { Error("admission", error.code, error.win32); return 2; }
      catch (...) { Error("admission", "CLIENT_FAILED"); return 2; }
}
