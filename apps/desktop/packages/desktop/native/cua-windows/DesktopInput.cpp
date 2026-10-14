#include "DesktopControl.h"
#include "DesktopTakeover.h"
#include <map>
#include <chrono>

namespace fcode::cua {
std::atomic<DesktopControl*> DesktopControl::hookOwner = nullptr;
namespace {
WORD namedKey(std::string const& name) {
  static const std::map<std::string, int> named{{"WIN", VK_LWIN}, {"CTRL", VK_CONTROL}, {"ALT", VK_MENU}, {"SHIFT", VK_SHIFT},
    {"ENTER", VK_RETURN}, {"ESC", VK_ESCAPE}, {"TAB", VK_TAB}, {"SPACE", VK_SPACE}, {"BACKSPACE", VK_BACK}, {"DELETE", VK_DELETE},
    {"INSERT", VK_INSERT}, {"HOME", VK_HOME}, {"END", VK_END}, {"PAGEUP", VK_PRIOR}, {"PAGEDOWN", VK_NEXT},
    {"UP", VK_UP}, {"DOWN", VK_DOWN}, {"LEFT", VK_LEFT}, {"RIGHT", VK_RIGHT}};
  auto found = named.find(name); if (found != named.end()) return static_cast<WORD>(found->second);
  if (name.size() == 1 && ((name[0] >= 'A' && name[0] <= 'Z') || (name[0] >= '0' && name[0] <= '9'))) return static_cast<WORD>(name[0]);
  if (name.size() >= 2 && name.size() <= 3 && name[0] == 'F') {
    unsigned value = 0; for (size_t i = 1; i < name.size(); ++i) { require(name[i] >= '0' && name[i] <= '9', "unsupported_action"); value = value * 10 + name[i] - '0'; }
    require(value >= 1 && value <= 24, "unsupported_action"); return static_cast<WORD>(VK_F1 + value - 1);
  }
  throw Error("unsupported_action");
}
INPUT key(WORD value, bool up, bool unicode = false) {
  INPUT result{}; result.type = INPUT_KEYBOARD; result.ki.wVk = unicode ? 0 : value; result.ki.wScan = unicode ? value : 0;
  result.ki.dwFlags = (up ? KEYEVENTF_KEYUP : 0) | (unicode ? KEYEVENTF_UNICODE : 0);
  if (!unicode && (value == VK_LWIN || value == VK_INSERT || value == VK_DELETE || value == VK_HOME || value == VK_END ||
    value == VK_PRIOR || value == VK_NEXT || (value >= VK_LEFT && value <= VK_DOWN))) result.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
  return result;
}
INPUT mouse(DWORD flags, DWORD data = 0) { INPUT result{}; result.type = INPUT_MOUSE; result.mi.dwFlags = flags; result.mi.mouseData = data; return result; }
bool sameKey(INPUT const& a, INPUT const& b) { return a.type == b.type && a.ki.wVk == b.ki.wVk && a.ki.wScan == b.ki.wScan; }
}
DesktopControl::~DesktopControl() { endHooks(); release(); }
LRESULT CALLBACK DesktopControl::keyboardHook(int code, WPARAM message, LPARAM data) {
  if (code >= 0) if (auto owner = hookOwner.load()) {
    auto event = reinterpret_cast<KBDLLHOOKSTRUCT*>(data);
    if (desktopTakeoverRequested(code, message, event->vkCode, event->flags, event->dwExtraInfo, InputTag)) {
      owner->activity++; owner->paused = true;
    }
  }
  return CallNextHookEx(nullptr, code, message, data);
}
void DesktopControl::startHooks() {
  require(!hooks.joinable(), "control_busy");
  auto ready = std::make_shared<std::promise<bool>>(); auto result = ready->get_future();
  hooks = std::thread([this, ready] {
    MSG message{}; PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
    hookThreadId = GetCurrentThreadId(); DesktopControl* empty = nullptr;
    if (!hookOwner.compare_exchange_strong(empty, this)) { ready->set_value(false); return; }
    auto keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, keyboardHook, GetModuleHandleW(nullptr), 0);
    ready->set_value(keyboard != nullptr);
    if (keyboard) while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
    if (keyboard) UnhookWindowsHookEx(keyboard);
    DesktopControl* owned = this; hookOwner.compare_exchange_strong(owned, nullptr); hookThreadId = 0;
  });
  if (result.wait_for(std::chrono::seconds(2)) != std::future_status::ready || !result.get()) {
    paused = true; endHooks(); throw Error("backend_unavailable");
  }
}
void DesktopControl::endHooks() {
  if (auto id = hookThreadId.load()) PostThreadMessageW(id, WM_QUIT, 0, 0);
  if (hooks.joinable()) hooks.join();
}
void DesktopControl::stop() { paused = true; scopeEpoch = 0; frame.reset(); endHooks(); }
void DesktopControl::send(std::vector<INPUT> const& values, std::mutex& gate, std::function<void()> const& permit) {
  std::lock_guard lock(gate); permit(); require(!paused && interactiveDesktop(), "canceled");
  auto tagged = values;
  for (auto& value : tagged) { if (value.type == INPUT_KEYBOARD) value.ki.dwExtraInfo = InputTag; else value.mi.dwExtraInfo = InputTag; }
  dispatched = true; auto inserted = SendInput(static_cast<UINT>(tagged.size()), tagged.data(), sizeof(INPUT));
  for (UINT index = 0; index < inserted; ++index) {
    auto value = tagged[index];
    if (value.type == INPUT_KEYBOARD) {
      if (value.ki.dwFlags & KEYEVENTF_KEYUP) std::erase_if(held, [&](auto const& previous) { return sameKey(previous, value); });
      else { value.ki.dwFlags |= KEYEVENTF_KEYUP; held.push_back(value); }
    } else {
      DWORD down = value.mi.dwFlags & (MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_RIGHTDOWN | MOUSEEVENTF_MIDDLEDOWN);
      if (down) { value.mi.dwFlags = down == MOUSEEVENTF_LEFTDOWN ? MOUSEEVENTF_LEFTUP : down == MOUSEEVENTF_RIGHTDOWN ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_MIDDLEUP; held.push_back(value); }
      DWORD up = value.mi.dwFlags & (MOUSEEVENTF_LEFTUP | MOUSEEVENTF_RIGHTUP | MOUSEEVENTF_MIDDLEUP);
      if (!down && up) std::erase_if(held, [&](auto const& previous) { return previous.type == INPUT_MOUSE && previous.mi.dwFlags == up; });
    }
  }
  require(inserted == tagged.size(), "execution_uncertain");
  permit();
}
bool DesktopControl::release() {
  if (held.empty()) return true;
  if (!interactiveDesktop()) return false;
  auto count = SendInput(static_cast<UINT>(held.size()), held.data(), sizeof(INPUT));
  if (count != held.size()) return false;
  held.clear(); return true;
}
void DesktopControl::move(POINT point, std::mutex& gate, std::function<void()> const& permit) {
  auto width = GetSystemMetrics(SM_CXVIRTUALSCREEN), height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  require(width > 1 && height > 1, "backend_unavailable");
  auto input = mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK);
  input.mi.dx = static_cast<LONG>((int64_t(point.x) - GetSystemMetrics(SM_XVIRTUALSCREEN)) * 65535 / (width - 1));
  input.mi.dy = static_cast<LONG>((int64_t(point.y) - GetSystemMetrics(SM_YVIRTUALSCREEN)) * 65535 / (height - 1));
  send({input}, gate, permit);
}
Json DesktopControl::execute(std::string const& scope, uint64_t epoch, std::string const& method, Json const& args,
    std::mutex& gate, std::function<void()> const& permit) {
  DesktopFrame observed{}; dispatched = false;
  bool keyboard = method == "desktop_type_text" || method == "desktop_press_keys";
  { std::lock_guard lock(gate); permit(); validateScope(scope, epoch);
    require(frame && frame->id == text(args, "frameId", 128), "observation_stale"); observed = *frame; checkFrame(observed, keyboard);
  }
  auto live = [&] {
    permit(); validateScope(scope, epoch); require(activity == observed.activity, "canceled");
    if (keyboard) checkFrame(observed, true);
  };
  auto consume = [&] { std::lock_guard lock(gate); permit(); checkFrame(observed, keyboard); frame.reset(); };
  auto noModifiers = [&] { for (auto value : {VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN, VK_LBUTTON, VK_RBUTTON, VK_MBUTTON}) require(!(GetAsyncKeyState(value) & 0x8000), "control_busy"); };
  if (method == "desktop_type_text") {
    exact(args, {"frameId", "text"}, {"frameId", "text"}); auto value = std::wstring(wide(text(args, "text", 16384)));
    noModifiers(); consume();
    for (size_t offset = 0; offset < value.size();) {
      std::vector<INPUT> batch;
      auto end = std::min(offset + 32, static_cast<size_t>(value.size()));
      if (end < value.size() && value[end - 1] >= 0xd800 && value[end - 1] <= 0xdbff) ++end;
      for (; offset < end; ++offset) { batch.push_back(key(value[offset], false, true)); batch.push_back(key(value[offset], true, true)); }
      send(batch, gate, live);
    }
  } else if (method == "desktop_press_keys") {
    exact(args, {"frameId", "keys"}, {"frameId", "keys"}); auto keys = args.Lookup(L"keys").GetArray();
    require(keys.Size() >= 1 && keys.Size() <= 8); std::vector<WORD> pressed; std::vector<INPUT> batch;
    for (auto const& value : keys) { auto named = namedKey(utf8(value.GetString())); require(std::find(pressed.begin(), pressed.end(), named) == pressed.end()); pressed.push_back(named); batch.push_back(key(named, false)); }
    for (auto index = pressed.rbegin(); index != pressed.rend(); ++index) batch.push_back(key(*index, true));
    noModifiers(); consume();
    // A complete key chord may intentionally change foreground/focus; recheck before its single OS batch.
    bool dispatchedChord = false;
    send(batch, gate, [&] {
      permit(); validateScope(scope, epoch); require(activity == observed.activity, "canceled");
      if (!dispatchedChord) { checkFrame(observed, true); dispatchedChord = true; }
    });
  } else {
    if (method == "desktop_click") exact(args, {"frameId", "x", "y", "button", "count"}, {"frameId", "x", "y"});
    else if (method == "desktop_move") exact(args, {"frameId", "x", "y"}, {"frameId", "x", "y"});
    else if (method == "desktop_scroll") exact(args, {"frameId", "x", "y", "deltaX", "deltaY"}, {"frameId", "x", "y", "deltaY"});
    else if (method == "desktop_drag") exact(args, {"frameId", "x", "y", "toX", "toY", "durationMs"}, {"frameId", "x", "y", "toX", "toY"});
    else throw Error("unsupported_action");
    auto start = point(observed, args, "x", "y"); validateWindow(WindowFromPoint(start));
    noModifiers(); consume(); move(start, gate, live);
    if (method == "desktop_click") {
      auto button = args.HasKey(L"button") ? text(args, "button", 16) : "left";
      require(button == "left" || button == "right" || button == "middle");
      auto down = button == "left" ? MOUSEEVENTF_LEFTDOWN : button == "right" ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_MIDDLEDOWN;
      auto up = button == "left" ? MOUSEEVENTF_LEFTUP : button == "right" ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_MIDDLEUP;
      auto count = args.HasKey(L"count") ? number(args, "count", 1, 3) : 1;
      for (int64_t index = 0; index < count; ++index) {
        send({mouse(down), mouse(up)}, gate, [&] { live(); validateWindow(WindowFromPoint(start)); });
        if (index + 1 < count) Sleep(50);
      }
    } else if (method == "desktop_scroll") {
      auto vertical = number(args, "deltaY", -10000, 10000), horizontal = args.HasKey(L"deltaX") ? number(args, "deltaX", -10000, 10000) : 0;
      if (vertical) send({mouse(MOUSEEVENTF_WHEEL, static_cast<DWORD>(-vertical))}, gate, live);
      if (horizontal) send({mouse(MOUSEEVENTF_HWHEEL, static_cast<DWORD>(horizontal))}, gate, live);
    } else if (method == "desktop_drag") {
      auto end = point(observed, args, "toX", "toY"); validateWindow(WindowFromPoint(end));
      auto duration = args.HasKey(L"durationMs") ? number(args, "durationMs", 100, 2000) : 300;
      auto steps = std::max<int64_t>(2, duration / 25);
      send({mouse(MOUSEEVENTF_LEFTDOWN)}, gate, live);
      for (int64_t step = 1; step <= steps; ++step) { Sleep(static_cast<DWORD>(duration / steps));
        POINT next{start.x + static_cast<LONG>((int64_t(end.x) - start.x) * step / steps), start.y + static_cast<LONG>((int64_t(end.y) - start.y) * step / steps)};
        move(next, gate, [&] { live(); validateWindow(WindowFromPoint(next)); });
      }
      send({mouse(MOUSEEVENTF_LEFTUP)}, gate, live);
    }
  }
  Json result; put(result, "status", "dispatched"); putBool(result, "effectVerified", false);
  put(result, "inputRouting", "foreground"); put(result, "inputBackend", "win32-send-input"); return result;
}
}
