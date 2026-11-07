// Copyright (c) Season Framework contributors.
// Build-only experiment. This header grants no installation or input capability.
#pragma once
#include <Windows.h>
#include <winioctl.h>
#include <stdint.h>

namespace reviewops::display {
inline constexpr uint32_t ProtocolVersion = 1;
inline constexpr uint32_t MaximumMonitors = 8;
inline constexpr GUID InterfaceId = {0x54af4a35, 0x1a70, 0x4d76, {0x90, 0xef, 0x83, 0xc8, 0xaa, 0x23, 0x7b, 0xb3}};

inline constexpr ULONG Query = CTL_CODE(FILE_DEVICE_UNKNOWN, 0x800, METHOD_BUFFERED, FILE_READ_DATA);
inline constexpr ULONG Create = CTL_CODE(FILE_DEVICE_UNKNOWN, 0x801, METHOD_BUFFERED, FILE_READ_DATA | FILE_WRITE_DATA);
inline constexpr ULONG Remove = CTL_CODE(FILE_DEVICE_UNKNOWN, 0x802, METHOD_BUFFERED, FILE_READ_DATA | FILE_WRITE_DATA);

struct Header { uint32_t size; uint32_t version; };
struct CreateRequest {
    Header header;
    uint32_t width;
    uint32_t height;
    uint32_t refreshHz;
    uint32_t reserved;
};
struct RemoveRequest {
    Header header;
    GUID monitorId;
    uint32_t reserved[2];
};
enum class State : uint32_t {
    AdapterNotReady = 0,
    Empty = 1,
    Attached = 2,
    RemovalUnconfirmed = 3,
    FileClosing = 4,
    DeviceStopping = 5
};
struct Reply {
    Header header;
    GUID deviceId;
    GUID fileOwnerId;
    GUID monitorId;
    State state;
    uint32_t connectorIndex;
    uint32_t width;
    uint32_t height;
    uint32_t refreshHz;
    uint32_t nativeStatus;
    uint32_t adapterLuidLow;
    int32_t adapterLuidHigh;
    uint32_t osTargetId;
    uint32_t reserved;
};
static_assert(sizeof(Header) == 8);
static_assert(sizeof(CreateRequest) == 24);
static_assert(sizeof(RemoveRequest) == 32);
static_assert(sizeof(Reply) == 96);
}
