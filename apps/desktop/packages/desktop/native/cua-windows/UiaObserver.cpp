#include <windows.h>
#include <ole2.h>
#include <UIAutomation.h>
#include <wrl/client.h>
#include "UiaObserver.h"
#include "TargetAccess.h"
#include "NativeCrypto.h"
#include <tlhelp32.h>
#include <charconv>
#include <fcntl.h>
#include <io.h>
#include <iostream>

namespace fcode::cua {
using Microsoft::WRL::ComPtr;
namespace {
thread_local bool dispatching = false;
uintptr_t handleAddress(std::string const& raw) {
  uintptr_t address = 0;
  auto parsed = std::from_chars(raw.data(), raw.data() + raw.size(), address);
  require(parsed.ec == std::errc{} && parsed.ptr == raw.data() + raw.size() && address != 0, "target_changed");
  return address;
}
std::string runtimeId(IUIAutomationElement* element) {
  SAFEARRAY* raw = nullptr;
  if (FAILED(element->GetRuntimeId(&raw)) || !raw) return {};
  struct Array { SAFEARRAY* value; ~Array() { SafeArrayDestroy(value); } } owned{raw};
  VARTYPE type = VT_EMPTY; LONG lower = 0, upper = -1;
  require(SafeArrayGetDim(raw) == 1 && SUCCEEDED(SafeArrayGetVartype(raw, &type)) && type == VT_I4 &&
    SUCCEEDED(SafeArrayGetLBound(raw, 1, &lower)) && SUCCEEDED(SafeArrayGetUBound(raw, 1, &upper)) &&
    upper >= lower && static_cast<int64_t>(upper) - lower < 128, "uia_unavailable");
  std::string result;
  for (LONG index = lower; index <= upper; ++index) {
    LONG value = 0; require(SUCCEEDED(SafeArrayGetElement(raw, &index, &value)), "uia_unavailable");
    if (!result.empty()) result += ':';
    result += std::to_string(value);
  }
  return result;
}
DWORD parentPid() {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  require(snapshot.get() != INVALID_HANDLE_VALUE, "uia_unavailable");
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot.get(), &entry)) do {
    if (entry.th32ProcessID == GetCurrentProcessId()) return entry.th32ParentProcessID;
  } while (Process32NextW(snapshot.get(), &entry));
  throw Error("uia_unavailable");
}
std::wstring image(HANDLE process) {
  std::wstring result(32768, L'\0'); DWORD size = static_cast<DWORD>(result.size());
  require(QueryFullProcessImageNameW(process, 0, result.data(), &size) != FALSE, "uia_unavailable");
  result.resize(size); return result;
}
uint64_t creation(HANDLE process) {
  FILETIME created{}, exited{}, kernel{}, user{};
  require(GetProcessTimes(process, &created, &exited, &kernel, &user), "uia_unavailable");
  ULARGE_INTEGER time{}; time.LowPart = created.dwLowDateTime; time.HighPart = created.dwHighDateTime;
  return time.QuadPart;
}
std::string role(CONTROLTYPEID type) {
  switch (type) {
    case UIA_ButtonControlTypeId: return "Button";
    case UIA_EditControlTypeId: return "Edit";
    case UIA_TextControlTypeId: return "Text";
    case UIA_WindowControlTypeId: return "Window";
    case UIA_PaneControlTypeId: return "Pane";
    case UIA_ComboBoxControlTypeId: return "ComboBox";
    case UIA_CheckBoxControlTypeId: return "CheckBox";
    case UIA_MenuControlTypeId: return "Menu";
    case UIA_MenuItemControlTypeId: return "MenuItem";
    case UIA_ListControlTypeId: return "List";
    case UIA_ListItemControlTypeId: return "ListItem";
    default: return "Control";
  }
}
Json observe(Json const& request, bool input) {
  exact(request, {"parentPid", "pid", "instanceId", "hwnd", "threadId", "deadline", "runtimeId", "action", "value", "cancelHandle"},
    {"parentPid", "pid", "instanceId", "hwnd", "threadId", "deadline"});
  if (input) {
    require(request.HasKey(L"runtimeId") && request.HasKey(L"action") && request.HasKey(L"cancelHandle"));
    auto action = text(request, "action", 32);
    require(action == "press" || action == "set_value" || action == "prepare", "unsupported_action");
    require((action == "set_value") == request.HasKey(L"value"));
    if (request.HasKey(L"value")) text(request, "value", 16384);
  } else require(!request.HasKey(L"runtimeId") && !request.HasKey(L"action") && !request.HasKey(L"value") && !request.HasKey(L"cancelHandle"));
  auto actualParent = parentPid();
  require(number(request, "parentPid", 1, MAXDWORD) == actualParent, "uia_unavailable");
  ULONG inputServer = 0, outputServer = 0;
  require(GetNamedPipeServerProcessId(GetStdHandle(STD_INPUT_HANDLE), &inputServer) &&
    GetNamedPipeServerProcessId(GetStdHandle(STD_OUTPUT_HANDLE), &outputServer) &&
    inputServer == actualParent && outputServer == actualParent, "uia_unavailable");
  Handle parent(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, actualParent));
  requireTargetAccess(parent.get(), actualParent);
  auto ownImage = image(GetCurrentProcess()), parentImage = image(parent.get());
  require(_wcsicmp(ownImage.c_str(), parentImage.c_str()) == 0 &&
    constantEqual(fileHash(ownImage), fileHash(parentImage)) && creation(parent.get()) <= creation(GetCurrentProcess()), "uia_unavailable");
  auto deadline = static_cast<uint64_t>(number(request, "deadline"));
  require(deadline > GetTickCount64() && deadline <= GetTickCount64() + 3000, "uia_timeout");
  auto pid = static_cast<DWORD>(number(request, "pid", 1, MAXDWORD));
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
  requireTargetAccess(process.get(), pid);
  require(text(request, "instanceId", 256) == std::to_string(pid) + ":" + std::to_string(creation(process.get())), "target_changed");
  auto hwnd = reinterpret_cast<HWND>(handleAddress(text(request, "hwnd", 32)));
  auto cancellation = input ? reinterpret_cast<HANDLE>(handleAddress(text(request, "cancelHandle", 32))) : nullptr;
  auto thread = static_cast<DWORD>(number(request, "threadId", 1, MAXDWORD));
  auto live = [&] {
    DWORD owner = 0;
    require(GetTickCount64() < deadline, "uia_timeout");
    require(!cancellation || WaitForSingleObject(cancellation, 0) == WAIT_TIMEOUT, "uia_unavailable");
    require(WaitForSingleObject(parent.get(), 0) == WAIT_TIMEOUT && interactiveDesktop(), "uia_unavailable");
    require(IsWindow(hwnd) && GetWindowThreadProcessId(hwnd, &owner) == thread && owner == pid &&
      WaitForSingleObject(process.get(), 0) == WAIT_TIMEOUT, "target_changed");
  };
  live();
  ComPtr<IUIAutomation> automation;
  require(SUCCEEDED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation))), "uia_unavailable");
  ComPtr<IUIAutomationElement> root;
  require(SUCCEEDED(automation->ElementFromHandle(hwnd, &root)) && root, "uia_unavailable");
  ComPtr<IUIAutomationTreeWalker> walker;
  require(SUCCEEDED(automation->get_ControlViewWalker(&walker)) && walker, "uia_unavailable");
  struct Node { ComPtr<IUIAutomationElement> element; uint32_t depth; };
  std::vector<Node> pending{ {root, 0} };
  JsonArray elements;
  JsonArray bindings;
  bool truncated = false;
  size_t responseBytes = 128;
  while (!pending.empty()) {
    live();
    if (elements.Size() >= 300) { truncated = true; break; }
    auto node = pending.back(); pending.pop_back();
    int owner = 0; BOOL password = TRUE, enabled = FALSE; CONTROLTYPEID type = 0;
    require(SUCCEEDED(node.element->get_CurrentProcessId(&owner)) && owner == static_cast<int>(pid), "target_changed");
    require(SUCCEEDED(node.element->get_CurrentIsPassword(&password)) &&
      SUCCEEDED(node.element->get_CurrentIsEnabled(&enabled)) && SUCCEEDED(node.element->get_CurrentControlType(&type)), "uia_unavailable");
    UIA_HWND nativeHandle = nullptr;
    require(SUCCEEDED(node.element->get_CurrentNativeWindowHandle(&nativeHandle)), "uia_unavailable");
    if (nativeHandle) {
      auto native = reinterpret_cast<HWND>(nativeHandle); DWORD nativePid = 0;
      require(GetWindowThreadProcessId(native, &nativePid) != 0 && nativePid == pid &&
        (native == hwnd || IsChild(hwnd, native)), "target_changed");
      if (type == UIA_EditControlTypeId) {
        wchar_t className[256]{};
        require(GetClassNameW(native, className, static_cast<int>(std::size(className))) > 0, "target_changed");
        if ((_wcsicmp(className, L"Edit") == 0 || std::wstring_view(className).starts_with(L"WindowsForms10.EDIT.")) &&
            (GetWindowLongPtrW(native, GWL_STYLE) & ES_PASSWORD)) password = TRUE;
      }
    }
    auto identity = runtimeId(node.element.Get());
    if (input && identity == text(request, "runtimeId", 2048)) {
      require(!password, "sensitive_target"); require(enabled != FALSE, "unsupported_action");
      auto action = text(request, "action", 32);
      Json result; put(result, "status", "dispatched"); putBool(result, "effectVerified", false); put(result, "inputRouting", "background");
      require(nativeHandle != nullptr, "unsupported_action");
      auto control = reinterpret_cast<HWND>(nativeHandle);
      wchar_t className[256]{};
      require(GetClassNameW(control, className, static_cast<int>(std::size(className))) > 0, "target_changed");
      DWORD_PTR returned = 0;
      Json receiver; put(receiver, "hwnd", std::to_string(reinterpret_cast<uintptr_t>(control)));
      put(receiver, "threadId", uint64_t{GetWindowThreadProcessId(control, nullptr)});
      if (action == "prepare") {
        require(type == UIA_EditControlTypeId && (_wcsicmp(className, L"Edit") == 0 ||
          std::wstring_view(className).starts_with(L"WindowsForms10.EDIT.")), "unsupported_action");
        require((GetWindowLongPtrW(control, GWL_STYLE) & (ES_PASSWORD | ES_READONLY)) == 0, "sensitive_target");
        Json prepared; prepared.Insert(L"receiver", receiver); live(); return prepared;
      }
      if (action == "press") {
        require(type == UIA_ButtonControlTypeId && (_wcsicmp(className, L"Button") == 0 ||
          std::wstring_view(className).starts_with(L"WindowsForms10.BUTTON.")), "unsupported_action");
        auto parentControl = GetParent(control); DWORD receiverPid = 0;
        require(parentControl && (parentControl == hwnd || IsChild(hwnd, parentControl)) && GetWindowThreadProcessId(parentControl, &receiverPid) && receiverPid == pid, "target_changed");
        live(); dispatching = true;
        require(SendMessageTimeoutW(parentControl, WM_COMMAND, MAKEWPARAM(GetDlgCtrlID(control), BN_CLICKED),
          reinterpret_cast<LPARAM>(control), SMTO_ABORTIFHUNG | SMTO_BLOCK, 500, &returned) != 0, "execution_uncertain");
      } else {
        require(type == UIA_EditControlTypeId && (_wcsicmp(className, L"Edit") == 0 ||
          std::wstring_view(className).starts_with(L"WindowsForms10.EDIT.")), "unsupported_action");
        require((GetWindowLongPtrW(control, GWL_STYLE) & (ES_PASSWORD | ES_READONLY)) == 0, "sensitive_target");
        auto value = wide(text(request, "value", 16384));
        live(); dispatching = true;
        require(SendMessageTimeoutW(control, WM_SETTEXT, 0, reinterpret_cast<LPARAM>(value.c_str()),
          SMTO_ABORTIFHUNG | SMTO_BLOCK, 500, &returned) != 0 && returned != 0, "execution_uncertain");
      }
      put(result, "inputBackend", "win32-window-messages");
      if (action == "set_value") result.Insert(L"receiver", receiver);
      live(); return result;
    }
    Json element;
    put(element, "index", uint64_t{elements.Size()}); put(element, "role", role(type));
    putBool(element, "enabled", enabled != FALSE); putBool(element, "isPassword", password != FALSE);
    JsonArray actions;
    if (!password && enabled && nativeHandle) {
      auto native = reinterpret_cast<HWND>(nativeHandle);
      wchar_t className[256]{};
      require(GetClassNameW(native, className, static_cast<int>(std::size(className))) > 0, "target_changed");
      if (native != hwnd && IsWindowVisible(native) && IsWindowEnabled(native)) {
        if (type == UIA_ButtonControlTypeId && (_wcsicmp(className, L"Button") == 0 ||
            std::wstring_view(className).starts_with(L"WindowsForms10.BUTTON."))) actions.Append(JsonValue::CreateStringValue(L"press"));
        if (type == UIA_EditControlTypeId && (_wcsicmp(className, L"Edit") == 0 ||
            std::wstring_view(className).starts_with(L"WindowsForms10.EDIT.")) &&
            (GetWindowLongPtrW(native, GWL_STYLE) & (ES_PASSWORD | ES_READONLY)) == 0) actions.Append(JsonValue::CreateStringValue(L"set_value"));
      }
    }
    element.Insert(L"actions", actions);
    if (!password) {
      BSTR name = nullptr;
      if (SUCCEEDED(node.element->get_CurrentName(&name)) && name) {
        element.Insert(L"name", JsonValue::CreateStringValue(winrt::hstring(name, std::min<UINT>(SysStringLen(name), 1024))));
      }
      if (name) SysFreeString(name);
      if (type == UIA_EditControlTypeId) {
        ComPtr<IUIAutomationValuePattern> valuePattern;
        BSTR value = nullptr;
        if (SUCCEEDED(node.element->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&valuePattern))) && valuePattern &&
            SUCCEEDED(valuePattern->get_CurrentValue(&value)) && value) {
          element.Insert(L"value", JsonValue::CreateStringValue(winrt::hstring(value, std::min<UINT>(SysStringLen(value), 4096))));
        }
        if (value) SysFreeString(value);
      }
    }
    responseBytes += stringify(element).size() + identity.size() + 4;
    if (responseBytes >= 60 * 1024) { truncated = true; break; }
    elements.Append(element);
    bindings.Append(JsonValue::CreateStringValue(wide(password ? "" : identity)));
    ComPtr<IUIAutomationElement> sibling;
    if (node.depth > 0) {
      require(SUCCEEDED(walker->GetNextSiblingElement(node.element.Get(), &sibling)), "uia_unavailable");
      if (sibling) pending.push_back({sibling, node.depth});
    }
    ComPtr<IUIAutomationElement> child;
    if (!password) {
      require(SUCCEEDED(walker->GetFirstChildElement(node.element.Get(), &child)), "uia_unavailable");
      if (child) {
        if (node.depth < 24) pending.push_back({child, node.depth + 1});
        else truncated = true;
      }
    }
  }
  live();
  require(!input, "observation_stale");
  Json result; result.Insert(L"elements", elements); result.Insert(L"bindings", bindings); putBool(result, "truncated", truncated);
  if (truncated) put(result, "reason", "uia_observation_limit");
  return result;
}
}
int uiaObserverMain(bool input) {
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
    std::string line; char character = '\0';
    while (std::cin.get(character) && character != '\n') {
      require(line.size() < 65536, "uia_unavailable"); line += character;
    }
    require(character == '\n', "uia_unavailable");
    auto result = observe(parse(line, 65536), input);
    auto bytes = stringify(result); require(bytes.size() < 65536, "uia_unavailable");
    std::cout << bytes << '\n' << std::flush;
    return std::cout ? 0 : 1;
  } catch (Error const& error) {
    Json result;
    auto code = dispatching ? "execution_uncertain" : error.code == "target_changed" || error.code == "target_access_denied" ||
      error.code == "uia_timeout" || error.code == "unsupported_action" || error.code == "sensitive_target" || error.code == "observation_stale" ? error.code : "uia_unavailable";
    put(result, "error", code); std::cout << stringify(result) << '\n' << std::flush;
    return 1;
  } catch (...) {
    std::cout << (dispatching ? "{\"error\":\"execution_uncertain\"}\n" : "{\"error\":\"uia_unavailable\"}\n") << std::flush;
    return 1;
  }
}
}
