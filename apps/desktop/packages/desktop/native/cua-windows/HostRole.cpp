#include <windows.h>
#include <ole2.h>
#ifdef GetObject
#undef GetObject
#endif
#include <wbemidl.h>
#include <wrl/client.h>
#include <shellapi.h>
#include "HostRole.h"
#include "HostPolicy.h"
#include "NativeCrypto.h"
#include <filesystem>

namespace fcode::cua {
namespace {
using Microsoft::WRL::ComPtr;
class Bstr {
public:
  explicit Bstr(wchar_t const* text) : value(SysAllocString(text)) { require(value != nullptr, "identity_invalid"); }
  ~Bstr() { SysFreeString(value); }
  BSTR get() const { return value; }
private:
  BSTR value;
};
std::wstring commandLine(DWORD pid) {
  ComPtr<IWbemLocator> locator;
  require(SUCCEEDED(CoCreateInstance(CLSID_WbemLocator, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&locator))), "identity_invalid");
  Bstr space(L"ROOT\\CIMV2"); ComPtr<IWbemServices> service;
  // Bootstrap timeout/cancellation terminates this owned helper if local WMI stalls.
  require(SUCCEEDED(locator->ConnectServer(space.get(), nullptr, nullptr, nullptr, WBEM_FLAG_CONNECT_USE_MAX_WAIT, nullptr, nullptr, &service)), "identity_invalid");
  require(SUCCEEDED(CoSetProxyBlanket(service.Get(), RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, nullptr,
    RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE, nullptr, EOAC_NONE)), "identity_invalid");
  auto name = L"Win32_Process.Handle=\"" + std::to_wstring(pid) + L"\"";
  Bstr objectName(name.c_str()); ComPtr<IWbemClassObject> object;
  require(SUCCEEDED(service->GetObject(objectName.get(), 0, nullptr, &object, nullptr)), "identity_invalid");
  VARIANT property; VariantInit(&property);
  auto result = object->Get(L"CommandLine", 0, &property, nullptr, nullptr);
  bool valid = SUCCEEDED(result) && property.vt == VT_BSTR && property.bstrVal && SysStringLen(property.bstrVal) > 0 && SysStringLen(property.bstrVal) <= 32768;
  std::wstring value = valid ? std::wstring(property.bstrVal, SysStringLen(property.bstrVal)) : L"";
  VariantClear(&property); require(valid, "identity_invalid"); return value;
}
bool samePath(std::wstring const& left, std::wstring const& right) {
  try {
    if (!std::filesystem::path(left).is_absolute() || !std::filesystem::path(right).is_absolute()) return false;
    auto a = std::filesystem::canonical(left).wstring(), b = std::filesystem::canonical(right).wstring();
    return _wcsicmp(a.c_str(), b.c_str()) == 0;
  } catch (...) { return false; }
}
}
std::string hostRole() { return FCODE_HOST_ROLE; }
void requireHostRole(DWORD pid, HANDLE process, std::wstring const& image) {
  if (hostRole() == "prototype-image") return;
  require(hostRole() == "electron-main", "identity_invalid");
  auto command = commandLine(pid);
  require(WaitForSingleObject(process, 0) == WAIT_TIMEOUT, "identity_invalid");
  int count = 0; auto arguments = CommandLineToArgvW(command.c_str(), &count);
  require(arguments != nullptr, "identity_invalid");
  bool correct = count == 2 && samePath(arguments[0], image) && samePath(arguments[1], FCODE_HOST_APP_ROOT);
  LocalFree(arguments); require(correct, "identity_invalid");
  auto root = std::filesystem::path(FCODE_HOST_APP_ROOT);
  require(constantEqual(fileHash((root / L"package.json").wstring()), FCODE_HOST_PACKAGE_SHA256) &&
    constantEqual(fileHash((root / L"out" / L"main" / L"index.js").wstring()), FCODE_HOST_ENTRY_SHA256), "identity_invalid");
  require(WaitForSingleObject(process, 0) == WAIT_TIMEOUT, "identity_invalid");
}
}
