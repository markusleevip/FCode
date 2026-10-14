#include "DesktopControl.h"
#include "NativeCrypto.h"
#include "TargetAccess.h"
#include <filesystem>
#include <climits>

namespace fcode::cua {
namespace {
std::wstring image(DWORD pid) {
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  require(process.get() != nullptr, "target_access_denied");
  std::wstring path(32768, L'\0'); DWORD length = static_cast<DWORD>(path.size());
  require(QueryFullProcessImageNameW(process.get(), 0, path.data(), &length), "target_access_denied");
  path.resize(length); return path;
}
FILETIME created(HANDLE process) {
  FILETIME creation{}, exit{}, kernel{}, user{};
  require(GetProcessTimes(process, &creation, &exit, &kernel, &user), "target_changed"); return creation;
}
HWND focused(HWND foreground) {
  GUITHREADINFO info{sizeof(GUITHREADINFO)};
  return GetGUIThreadInfo(GetWindowThreadProcessId(foreground, nullptr), &info) ? info.hwndFocus : nullptr;
}
Json region(RECT const& bounds) {
  Json result; result.Insert(L"x", JsonValue::CreateNumberValue(bounds.left)); result.Insert(L"y", JsonValue::CreateNumberValue(bounds.top));
  put(result, "width", uint64_t(bounds.right - bounds.left)); put(result, "height", uint64_t(bounds.bottom - bounds.top)); return result;
}
}
std::vector<DesktopDisplay> desktopDisplays() {
  std::vector<DesktopDisplay> result;
  require(EnumDisplayMonitors(nullptr, nullptr, [](HMONITOR monitor, HDC, LPRECT, LPARAM data) -> BOOL {
    auto& values = *reinterpret_cast<std::vector<DesktopDisplay>*>(data);
    MONITORINFOEXW info{}; info.cbSize = sizeof(info);
    if (!GetMonitorInfoW(monitor, &info)) return FALSE;
    auto device = winrt::to_string(info.szDevice);
    auto id = sha256({reinterpret_cast<const uint8_t*>(device.data()), device.size()});
    values.push_back({monitor, info.rcMonitor, info.szDevice, id, (info.dwFlags & MONITORINFOF_PRIMARY) != 0}); return TRUE;
  }, reinterpret_cast<LPARAM>(&result)), "backend_unavailable");
  require(!result.empty() && result.size() <= 32, "backend_unavailable");
  std::sort(result.begin(), result.end(), [](auto const& a, auto const& b) { return a.id < b.id; }); return result;
}
std::string desktopTopology(std::vector<DesktopDisplay> const& displays) {
  std::string value;
  for (auto const& display : displays) {
    auto const& r = display.bounds;
    value += display.id + ":" + std::to_string(r.left) + ":" + std::to_string(r.top) + ":" +
      std::to_string(r.right) + ":" + std::to_string(r.bottom) + ":" + std::to_string(display.primary) + ";";
  }
  return sha256({reinterpret_cast<const uint8_t*>(value.data()), value.size()});
}
Json DesktopControl::displays() {
  auto values = desktopDisplays(); JsonArray catalog;
  for (auto const& display : values) {
    Json item; put(item, "displayId", display.id); putBool(item, "primary", display.primary);
    item.Insert(L"region", region(display.bounds)); catalog.Append(item);
  }
  Json result; result.Insert(L"displays", catalog); put(result, "topologyVersion", desktopTopology(values)); return result;
}
void DesktopControl::begin(std::string scope, std::string selected, uint64_t epoch, DWORD parentPid) {
  auto displays = desktopDisplays();
  require(std::any_of(displays.begin(), displays.end(), [&](auto const& value) { return value.id == selected; }), "target_unavailable");
  require(scopeEpoch == 0 || (scopeId == scope && scopeEpoch == epoch && displayId == selected), "control_busy");
  hostPid = parentPid; hostImage = image(parentPid);
  if (scopeEpoch != 0) { validateScope(scope, epoch); return; }
  scopeId = std::move(scope); displayId = std::move(selected); scopeEpoch = epoch;
  scopeTopology = desktopTopology(displays); frame.reset(); paused = false; startHooks();
}
void DesktopControl::validateScope(std::string const& scope, uint64_t epoch) {
  require(!paused && scopeEpoch == epoch && scopeId == scope, "not_authorized");
  require(interactiveDesktop(), "desktop_locked");
  require(scopeTopology == desktopTopology(desktopDisplays()), "desktop_changed");
}
bool DesktopControl::privateWindow(HWND hwnd) {
  DWORD pid = 0; GetWindowThreadProcessId(hwnd, &pid);
  if (!pid || pid == hostPid || pid == GetCurrentProcessId()) return true;
  try {
    auto path = image(pid); auto filename = std::filesystem::path(path).filename().wstring();
    return _wcsicmp(path.c_str(), hostImage.c_str()) == 0 || _wcsicmp(filename.c_str(), L"fcode.exe") == 0 ||
      _wcsicmp(filename.c_str(), L"fcode preview.exe") == 0 || _wcsicmp(filename.c_str(), L"fcode-cua-helper.exe") == 0;
  } catch (...) { return true; }
}
void DesktopControl::validateWindow(HWND hwnd) {
  require(hwnd && IsWindow(hwnd) && !privateWindow(hwnd), "not_authorized");
  DWORD pid = 0; GetWindowThreadProcessId(hwnd, &pid);
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
  requireTargetAccess(process.get(), pid);
  wchar_t className[256]{}; GetClassNameW(hwnd, className, 256);
  if (_wcsicmp(className, L"Edit") == 0 || std::wstring_view(className).starts_with(L"WindowsForms10.EDIT.")) {
    require(!(GetWindowLongPtrW(hwnd, GWL_STYLE) & ES_PASSWORD), "sensitive_target");
  }
}
void DesktopControl::mask(std::vector<uint8_t>& pixels, DesktopDisplay const& display) {
  struct Mask { DesktopControl* owner; std::vector<uint8_t>* pixels; DesktopDisplay const* display; } context{this, &pixels, &display};
  require(EnumWindows([](HWND hwnd, LPARAM data) -> BOOL {
    auto& context = *reinterpret_cast<Mask*>(data);
    if (!IsWindowVisible(hwnd) || IsIconic(hwnd) || !context.owner->privateWindow(hwnd)) return TRUE;
    RECT bounds{}, clipped{}; if (!GetWindowRect(hwnd, &bounds) || !IntersectRect(&clipped, &bounds, &context.display->bounds)) return TRUE;
    auto const& r = context.display->bounds; auto width = r.right - r.left;
    for (LONG y = clipped.top; y < clipped.bottom; ++y) {
      auto start = (static_cast<size_t>(y - r.top) * width + clipped.left - r.left) * 4;
      auto length = static_cast<size_t>(clipped.right - clipped.left) * 4;
      if (start + length <= context.pixels->size()) std::fill_n(context.pixels->begin() + start, length, uint8_t{0});
    }
    return TRUE;
  }, reinterpret_cast<LPARAM>(&context)), "capture_unavailable");
}
Json DesktopControl::capture(std::string const& scope, uint64_t epoch, Json const& args,
    std::mutex& gate, std::function<void()> const& permit) {
  exact(args, {"displayId"}, {});
  DesktopDisplay selected{}; uint64_t observedActivity = 0; HWND foreground = nullptr, focus = nullptr; DWORD pid = 0; FILETIME creation{};
  { std::lock_guard lock(gate); permit(); validateScope(scope, epoch);
    require(!args.HasKey(L"displayId") || text(args, "displayId", 128) == displayId, "not_authorized");
    auto values = desktopDisplays(); auto found = std::find_if(values.begin(), values.end(), [&](auto const& value) { return value.id == displayId; });
    require(found != values.end(), "observation_stale"); selected = *found; observedActivity = activity;
    foreground = GetForegroundWindow(); GetWindowThreadProcessId(foreground, &pid); focus = focused(foreground);
    if (pid) { Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)); if (process.get()) creation = created(process.get()); }
  }
  auto live = [&] { try { std::lock_guard lock(gate); permit(); validateScope(scope, epoch); return activity == observedActivity; } catch (...) { return false; } };
  auto captured = captureDesktopMonitor(selected, live, [&](auto& pixels) { mask(pixels, selected); });
  std::lock_guard lock(gate); permit(); validateScope(scope, epoch);
  require(activity == observedActivity, "canceled");
  require(foreground == GetForegroundWindow() && focus == focused(foreground), "observation_stale");
  auto id = randomHex(); frame = DesktopFrame{id, scope, scopeTopology, epoch, observedActivity, GetTickCount64() + 15000,
    selected, captured.width, captured.height, foreground, focus, pid, creation};
  Json observation; put(observation, "id", id); put(observation, "displayId", displayId); put(observation, "topologyVersion", scopeTopology);
  put(observation, "width", uint64_t{captured.width}); put(observation, "height", uint64_t{captured.height});
  observation.Insert(L"region", region(selected.bounds)); put(observation, "capturedAtMs", GetTickCount64());
  Json foregroundInfo; wchar_t title[1024]{};
  if (foreground && !privateWindow(foreground)) {
    GetWindowTextW(foreground, title, 1024); put(foregroundInfo, "title", winrt::to_string(title));
    try { put(foregroundInfo, "application", winrt::to_string(std::filesystem::path(image(pid)).stem().wstring())); } catch (...) {}
  }
  observation.Insert(L"foreground", foregroundInfo);
  Json png; put(png, "mimeType", "image/png"); put(png, "data", captured.png);
  Json result; result.Insert(L"image", png); result.Insert(L"desktopObservation", observation);
  Json application; put(application, "name", "Windows desktop"); result.Insert(L"application", application);
  put(result, "frameId", id); put(result, "coordinateSpace", "desktop-image-pixels"); put(result, "inputRouting", "foreground"); return result;
}
POINT DesktopControl::point(DesktopFrame const& observed, Json const& args, std::string_view x, std::string_view y) {
  auto px = number(args, x, 0, observed.width - 1), py = number(args, y, 0, observed.height - 1);
  auto const& bounds = observed.display.bounds;
  return {bounds.left + static_cast<LONG>(px * (bounds.right - bounds.left) / observed.width),
    bounds.top + static_cast<LONG>(py * (bounds.bottom - bounds.top) / observed.height)};
}
void DesktopControl::checkFrame(DesktopFrame const& observed, bool keyboard) {
  validateScope(observed.scope, observed.epoch);
  require(observed.expires > GetTickCount64() && activity == observed.activity, "observation_stale");
  require(GetForegroundWindow() == observed.foreground, "observation_stale");
  if (keyboard) {
    auto currentFocus = focused(observed.foreground);
    require(currentFocus == observed.focus, "observation_stale");
    validateWindow(currentFocus ? currentFocus : observed.foreground);
    DWORD pid = 0; GetWindowThreadProcessId(observed.foreground, &pid);
    require(pid == observed.pid, "target_changed");
    Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
    auto currentCreation = created(process.get());
    require(CompareFileTime(&currentCreation, &observed.creation) == 0, "target_changed");
  }
}
}
