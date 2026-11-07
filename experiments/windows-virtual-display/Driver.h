// Adapted from Microsoft's IndirectDisplay sample, commit
// d49bb7d72f3651952b2b6e4ad28d14fe2247eb69. See MS-PL.txt and README.md.
// Copyright (c) Microsoft Corporation.
// Copyright (c) Season Framework contributors.
#pragma once
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#include <wudfwdm.h>
#include <wdf.h>
#include <iddcx.h>
#include <dxgi1_5.h>
#include <d3d11.h>
#include <avrt.h>
#include <bcrypt.h>
#include <wrl.h>
#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <new>
#include <utility>
#include "ControlProtocol.h"

extern "C" DRIVER_INITIALIZE DriverEntry;
EVT_WDF_DRIVER_DEVICE_ADD ReviewOpsDeviceAdd;
EVT_WDF_DEVICE_D0_ENTRY ReviewOpsD0Entry;
EVT_WDF_OBJECT_CONTEXT_CLEANUP ReviewOpsDeviceCleanup;
EVT_WDF_DEVICE_FILE_CREATE ReviewOpsFileCreate;
EVT_WDF_FILE_CLEANUP ReviewOpsFileCleanup;
EVT_WDF_FILE_CLOSE ReviewOpsFileClose;
EVT_IDD_CX_DEVICE_IO_CONTROL ReviewOpsIoControl;
EVT_IDD_CX_ADAPTER_INIT_FINISHED ReviewOpsAdapterReady;
EVT_IDD_CX_ADAPTER_COMMIT_MODES ReviewOpsCommitModes;
EVT_IDD_CX_PARSE_MONITOR_DESCRIPTION ReviewOpsParseDescription;
EVT_IDD_CX_MONITOR_GET_DEFAULT_DESCRIPTION_MODES ReviewOpsDefaultModes;
EVT_IDD_CX_MONITOR_QUERY_TARGET_MODES ReviewOpsTargetModes;
EVT_IDD_CX_MONITOR_ASSIGN_SWAPCHAIN ReviewOpsAssignSwapChain;
EVT_IDD_CX_MONITOR_UNASSIGN_SWAPCHAIN ReviewOpsUnassignSwapChain;

class DeviceState;
class FileState;
class MonitorLease;
class SwapChainProcessor;
struct DeviceContext { DeviceState* state; };
struct FileContext { FileState* state; };
struct AdapterContext { DeviceState* state; volatile LONG completed; NTSTATUS initializationStatus; };
struct MonitorContext { MonitorLease* lease; SwapChainProcessor* processor; };
WDF_DECLARE_CONTEXT_TYPE_WITH_NAME(DeviceContext, GetDeviceContext);
WDF_DECLARE_CONTEXT_TYPE_WITH_NAME(FileContext, GetFileContext);
WDF_DECLARE_CONTEXT_TYPE_WITH_NAME(AdapterContext, GetAdapterContext);
WDF_DECLARE_CONTEXT_TYPE_WITH_NAME(MonitorContext, GetMonitorContext);
