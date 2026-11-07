#include "PackageAdmission.h"
#include <cstdio>
#include <cwchar>

int wmain(int argc, wchar_t** argv) {
    using namespace reviewops::display::admission;
    Inspection result;
    if (argc != 3 || wcscmp(argv[1], L"--inspect")) result.reason = "INVALID_ARGUMENT";
    else result = InspectPackage(argv[2]);
    // All strings are fixed names/reasons or locally calculated hex digests.
    // Paths, certificate display names and arbitrary Win32 messages never print.
    std::printf("{\"version\":1,\"operation\":\"inspect\",\"verified\":%s,\"reason\":\"%s\",\"nativeCode\":%ld,\"approvedSource\":\"%s\",\"files\":[",
        result.package ? "true" : "false", result.reason, result.nativeCode, ApprovedSource);
    for (size_t i = 0; i < result.files.size(); ++i) {
        const auto& file = result.files[i];
        std::printf("%s{\"name\":\"%s\",\"opened\":%s,\"size\":%llu,\"sha256\":\"%s\",\"sourcePinned\":%s,\"hashMatched\":%s,\"catalogVerified\":%s}",
            i ? "," : "", file.name, file.opened ? "true" : "false", static_cast<unsigned long long>(file.size), file.sha256.c_str(),
            file.sourcePinned ? "true" : "false", file.hashMatched ? "true" : "false", file.catalogVerified ? "true" : "false");
    }
    std::puts("]}");
    return result.package ? 0 : 2;
}
