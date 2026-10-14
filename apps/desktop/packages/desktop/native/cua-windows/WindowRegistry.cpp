#include "WindowRegistry.h"
#include "NativeCrypto.h"
#include "TargetAccess.h"
#include <dwmapi.h>
#include <filesystem>
#include <cwctype>
#include <unordered_set>

namespace fcode::cua {
namespace {
FILETIME creationTime(HANDLE process) {
  FILETIME creation{}, exit{}, kernel{}, user{};
  require(GetProcessTimes(process, &creation, &exit, &kernel, &user) != FALSE, "target_unavailable"); return creation;
}
std::string processInstance(DWORD pid, FILETIME const& time) {
  ULARGE_INTEGER value{}; value.LowPart = time.dwLowDateTime; value.HighPart = time.dwHighDateTime;
  return std::to_string(pid) + ":" + std::to_string(value.QuadPart);
}
std::wstring processImage(HANDLE handle) {
  std::wstring result(32768, L'\0'); DWORD size = static_cast<DWORD>(result.size());
  require(QueryFullProcessImageNameW(handle, 0, result.data(), &size) != FALSE, "target_unavailable"); result.resize(size); return result;
}
RECT bounds(HWND hwnd) {
  RECT result{};
  if (FAILED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &result, sizeof(result)))) require(GetWindowRect(hwnd, &result), "target_unavailable");
  require(result.right > result.left && result.bottom > result.top, "target_unavailable"); return result;
}
bool available(HWND hwnd) {
  DWORD cloaked = 0;
  return IsWindow(hwnd) && IsWindowVisible(hwnd) && SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && !cloaked;
}
std::string topology(RECT const& rect, UINT dpi) {
  return std::to_string(rect.left) + ":" + std::to_string(rect.top) + ":" + std::to_string(rect.right) + ":" +
    std::to_string(rect.bottom) + ":" + std::to_string(dpi);
}
Json region(RECT const& rect) {
  Json result;
  result.Insert(L"x", JsonValue::CreateNumberValue(rect.left)); result.Insert(L"y", JsonValue::CreateNumberValue(rect.top));
  put(result, "width", static_cast<uint64_t>(rect.right - rect.left)); put(result, "height", static_cast<uint64_t>(rect.bottom - rect.top)); return result;
}
}

WindowRegistry::WindowRegistry(DWORD hostPid) : hostPid(hostPid) {
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, hostPid));
  require(process.get() != nullptr, "identity_invalid"); hostImage = processImage(process.get());
  std::transform(hostImage.begin(), hostImage.end(), hostImage.begin(), [](wchar_t c) { return static_cast<wchar_t>(std::towlower(c)); });
}
std::shared_ptr<ProcessIdentity> WindowRegistry::process(DWORD pid) {
  require(pid != hostPid && pid != GetCurrentProcessId(), "not_authorized");
  auto previous = processes.find(pid);
  if (previous != processes.end() && WaitForSingleObject(previous->second->process->get(), 0) == WAIT_TIMEOUT) {
    requireTargetAccess(previous->second->process->get(), pid); return previous->second;
  }
  auto handle = std::make_shared<Handle>(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
  require(handle->get() != nullptr && WaitForSingleObject(handle->get(), 0) == WAIT_TIMEOUT, "target_unavailable");
  requireTargetAccess(handle->get(), pid);
  auto path = processImage(handle->get());
  auto normalized = path; std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](wchar_t c) { return static_cast<wchar_t>(std::towlower(c)); });
  auto filename = std::filesystem::path(normalized).filename().wstring();
  require(normalized != hostImage && filename != L"fcode.exe" && filename != L"fcode preview.exe" &&
    filename != L"fcode-cua-helper.exe", "not_authorized");
  require(filename != L"chrome.exe" && filename != L"msedge.exe" && filename != L"firefox.exe" && filename != L"applicationframehost.exe", "unsupported_target");
  auto bytes = winrt::to_string(normalized);
  auto identity = std::make_shared<ProcessIdentity>(ProcessIdentity{ handle, pid, processInstance(pid, creationTime(handle->get())),
    "win32:" + sha256({ reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size() }), path });
  processes.insert_or_assign(pid, identity); return identity;
}

void WindowRegistry::refresh() {
  std::vector<HWND> current;
  require(EnumWindows([](HWND hwnd, LPARAM data) -> BOOL {
    if (available(hwnd)) reinterpret_cast<std::vector<HWND>*>(data)->push_back(hwnd); return TRUE;
  }, reinterpret_cast<LPARAM>(&current)), "backend_unavailable");
  std::unordered_set<uint64_t> retained;
  std::unordered_set<HWND> watched;
  for (auto hwnd : current) {
    DWORD pid = 0; auto threadId = GetWindowThreadProcessId(hwnd, &pid);
    try {
      auto identity = process(pid);
      auto generation = lifecycle.watch(hwnd);
      watched.insert(hwnd);
      auto previous = std::find_if(registered.begin(), registered.end(), [&](auto const& pair) {
        return pair.second.hwnd == hwnd && pair.second.process->instanceId == identity->instanceId &&
          pair.second.generation == generation && pair.second.threadId == threadId;
      });
      if (previous != registered.end()) retained.insert(previous->first);
      else { require(nextWindowId < SafeInteger, "resource_limit"); registered.emplace(nextWindowId, WindowIdentity{ identity, hwnd, nextWindowId, generation, threadId }); retained.insert(nextWindowId++); }
    } catch (Error const& error) {
      if (error.code == "resource_limit" || error.code == "window_lifecycle_unavailable") throw;
      // Ineligible or inaccessible windows never enter the catalog.
    }
  }
  std::erase_if(receivers, [&](auto const& pair) {
    auto const& value = pair.second;
    if (!retained.contains(value.root.id) || !IsWindow(value.hwnd) || !IsChild(value.root.hwnd, value.hwnd)) return true;
    watched.insert(value.hwnd); return false;
  });
  lifecycle.retain(watched);
  std::erase_if(registered, [&](auto const& pair) { return !retained.contains(pair.first); });
  std::erase_if(processes, [](auto const& pair) { return WaitForSingleObject(pair.second->process->get(), 0) != WAIT_TIMEOUT; });
}

Json WindowRegistry::describe(WindowIdentity const& value, bool geometry) {
  DWORD pid = 0; auto threadId = GetWindowThreadProcessId(value.hwnd, &pid);
  require(pid == value.process->pid && threadId == value.threadId && available(value.hwnd) &&
    lifecycle.generation(value.hwnd) == value.generation, "target_changed");
  requireTargetAccess(value.process->process->get(), pid);
  Json target; put(target, "appId", value.process->appId); put(target, "pid", uint64_t{pid});
  put(target, "instanceId", value.process->instanceId); put(target, "windowId", value.id);
  if (geometry) {
    auto rect = bounds(value.hwnd); target.Insert(L"region", region(rect));
    put(target, "topologyVersion", topology(rect, GetDpiForWindow(value.hwnd)));
  }
  return target;
}
Json WindowRegistry::applications() {
  refresh(); JsonArray apps; std::unordered_set<std::string> seen;
  for (auto const& pair : registered) {
    auto identity = pair.second.process;
    if (!seen.insert(identity->instanceId).second) continue;
    Json app; put(app, "appId", identity->appId); put(app, "pid", uint64_t{identity->pid});
    put(app, "name", winrt::to_string(std::filesystem::path(identity->path).stem().wstring()));
    apps.Append(app);
  }
  Json runtime; put(runtime, "platform", "win32"); put(runtime, "nativeProtocolVersion", uint64_t{2});
  put(runtime, "inputRouting", "background"); put(runtime, "compatibility", "limited");
  JsonArray methods;
  for (auto method : { L"list_apps", L"list_windows", L"capture", L"get_app_state", L"element_action", L"click", L"type_text", L"press_keys" }) {
    methods.Append(JsonValue::CreateStringValue(method));
  }
  runtime.Insert(L"methods", methods);
  Json desktop; putBool(desktop, "available", true); put(desktop, "inputRouting", "foreground");
  put(desktop, "compatibility", "development"); put(desktop, "coordinateSpace", "desktop-image-pixels");
  runtime.Insert(L"desktop", desktop);
  Json result; result.Insert(L"apps", apps); result.Insert(L"runtime", runtime); return result;
}
WindowIdentity WindowRegistry::window(Json const& target) {
  refresh();
  exact(target, {"appId", "pid", "instanceId", "windowId", "region", "topologyVersion"}, {"appId", "pid"});
  auto appId = text(target, "appId"); auto pid = number(target, "pid", 1, MAXDWORD);
  std::vector<WindowIdentity> matches;
  for (auto const& pair : registered) if (pair.second.process->pid == pid && pair.second.process->appId == appId) {
    if (target.HasKey(L"instanceId")) require(pair.second.process->instanceId == text(target, "instanceId", 256), "target_changed");
    if (!target.HasKey(L"windowId") || pair.first == static_cast<uint64_t>(number(target, "windowId"))) matches.push_back(pair.second);
  }
  require(!matches.empty(), "target_unavailable");
  describe(matches.front(), false);
  if (!target.HasKey(L"windowId")) {
    // Resolving an application does not guess a window when it has multiple windows.
    return matches.front();
  }
  require(matches.size() == 1, "target_ambiguous"); return matches.front();
}
Json WindowRegistry::resolve(Json const& target) {
  auto value = window(target); auto result = describe(value, target.HasKey(L"windowId"));
  if (!target.HasKey(L"windowId")) result.Remove(L"windowId");
  Json envelope; envelope.Insert(L"target", result); return envelope;
}
Json WindowRegistry::windows(Json const& target) {
  auto identity = window(target).process; JsonArray windows;
  for (auto const& pair : registered) if (pair.second.process->instanceId == identity->instanceId) {
    Json value = describe(pair.second, true);
    wchar_t title[512]{}; GetWindowTextW(pair.second.hwnd, title, static_cast<int>(std::size(title)));
    value.Insert(L"title", JsonValue::CreateStringValue(title));
    putBool(value, "minimized", IsIconic(pair.second.hwnd) != FALSE); windows.Append(value);
  }
  Json result; result.Insert(L"windows", windows); return result;
}
WindowReceiver WindowRegistry::receiver(WindowIdentity const& root, HWND hwnd) {
  describe(root, false);
  require(hwnd != root.hwnd && IsChild(root.hwnd, hwnd), "unsupported_action");
  DWORD pid = 0; auto threadId = GetWindowThreadProcessId(hwnd, &pid);
  require(threadId && pid == root.process->pid && IsWindowVisible(hwnd) && IsWindowEnabled(hwnd), "target_changed");
  wchar_t name[256]{};
  require(GetClassNameW(hwnd, name, static_cast<int>(std::size(name))) > 0, "target_changed");
  require(receivers.contains(hwnd) || receivers.size() < 128, "resource_limit");
  auto value = WindowReceiver{root, hwnd, threadId, lifecycle.watch(hwnd), name};
  receivers.insert_or_assign(hwnd, value); return value;
}
WindowReceiver WindowRegistry::hit(WindowIdentity const& root, POINT screen) {
  describe(root, false);
  auto current = root.hwnd;
  for (unsigned depth = 0; depth < 32; ++depth) {
    auto client = screen; require(ScreenToClient(current, &client), "target_changed");
    RECT area{}; require(GetClientRect(current, &area) && PtInRect(&area, client), "unsupported_action");
    auto child = ChildWindowFromPointEx(current, client, CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT);
    if (!child || child == current) return receiver(root, current);
    current = child;
  }
  throw Error("resource_limit");
}
void WindowRegistry::validate(WindowReceiver const& value) {
  describe(value.root, false);
  DWORD pid = 0;
  require(GetWindowThreadProcessId(value.hwnd, &pid) == value.threadId && pid == value.root.process->pid &&
    IsWindowVisible(value.hwnd) && IsWindowEnabled(value.hwnd) && IsChild(value.root.hwnd, value.hwnd) &&
    lifecycle.generation(value.hwnd) == value.generation, "target_changed");
  wchar_t name[256]{};
  require(GetClassNameW(value.hwnd, name, static_cast<int>(std::size(name))) > 0 && value.className == name, "target_changed");
}
}
