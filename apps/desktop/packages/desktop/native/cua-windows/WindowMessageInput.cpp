#include "WindowMessageInput.h"
#include <climits>

namespace fcode::cua {
namespace {
bool named(WindowReceiver const& receiver, wchar_t const* simple, wchar_t const* forms) {
  return _wcsicmp(receiver.className.c_str(), simple) == 0 || receiver.className.starts_with(forms);
}
LPARAM clientPosition(WindowReceiver const& receiver, Json const& arguments, std::string_view xKey = "screenX", std::string_view yKey = "screenY") {
  POINT point{static_cast<LONG>(number(arguments, xKey, LONG_MIN, LONG_MAX)), static_cast<LONG>(number(arguments, yKey, LONG_MIN, LONG_MAX))};
  require(ScreenToClient(receiver.hwnd, &point), "target_changed");
  require(point.x >= SHRT_MIN && point.x <= SHRT_MAX && point.y >= SHRT_MIN && point.y <= SHRT_MAX, "unsupported_action");
  return MAKELPARAM(static_cast<WORD>(point.x), static_cast<WORD>(point.y));
}
bool mouseReceiver(WindowReceiver const& receiver) {
  return editableReceiver(receiver) || named(receiver, L"Button", L"WindowsForms10.BUTTON.") ||
    _wcsicmp(receiver.className.c_str(), L"SysListView32") == 0 || _wcsicmp(receiver.className.c_str(), L"SysTreeView32") == 0 ||
    named(receiver, L"ListBox", L"WindowsForms10.LISTBOX.");
}
}
bool editableReceiver(WindowReceiver const& receiver) {
  return named(receiver, L"Edit", L"WindowsForms10.EDIT.");
}
void WindowMessageInput::send(WindowRegistry& registry, WindowReceiver const& receiver, UINT message, WPARAM key, LPARAM position,
    std::mutex& gate, std::function<void()> const& permit, bool down, bool up) {
  std::lock_guard lock(gate);
  permit(); registry.validate(receiver);
  if (down) {
    require(!held.has_value(), "control_busy");
    UINT releaseMessage = message == WM_KEYDOWN ? WM_KEYUP : message == WM_LBUTTONDOWN ? WM_LBUTTONUP : message == WM_RBUTTONDOWN ? WM_RBUTTONUP : WM_MBUTTONUP;
    held = Held{receiver, releaseMessage,
      message == WM_KEYDOWN ? key : 0, message == WM_KEYDOWN ? static_cast<LPARAM>(static_cast<uintptr_t>(position) | 0xc0000000ULL) : position};
  }
  DWORD_PTR result = 0;
  dispatched = true;
  require(SendMessageTimeoutW(receiver.hwnd, message, key, position, SMTO_ABORTIFHUNG | SMTO_BLOCK, 250, &result) != 0, "execution_uncertain");
  if (held && message == WM_MOUSEMOVE) held->position = position;
  if (up) held.reset();
  permit(); registry.validate(receiver);
}
bool WindowMessageInput::release(WindowRegistry& registry) {
  if (!held) return true;
  auto value = *held;
  try {
    registry.validate(value.receiver);
    DWORD_PTR result = 0;
    if (!SendMessageTimeoutW(value.receiver.hwnd, value.message, value.key, value.position, SMTO_ABORTIFHUNG | SMTO_BLOCK, 250, &result)) return false;
    held.reset(); return true;
  } catch (...) { return false; }
}
Json WindowMessageInput::execute(WindowRegistry& registry, WindowReceiver const& receiver, std::string const& method, Json const& args,
    std::mutex& gate, std::function<void()> const& permit) {
  dispatched = false;
  registry.validate(receiver);
  if (editableReceiver(receiver)) require((GetWindowLongPtrW(receiver.hwnd, GWL_STYLE) & (ES_PASSWORD | ES_READONLY)) == 0, "sensitive_target");
  Json result; put(result, "status", "dispatched"); putBool(result, "effectVerified", false);
  put(result, "inputRouting", "background"); put(result, "inputBackend", "win32-window-messages");
  if (method == "click") {
    // Raw button-down messages activated the real WinForms target in acceptance.
    require(named(receiver, L"Button", L"WindowsForms10.BUTTON."), "unsupported_action");
    require(!args.HasKey(L"button") || text(args, "button", 16) == "left", "unsupported_action");
    require(!args.HasKey(L"count") || number(args, "count", 1, 3) == 1, "unsupported_action");
    auto style = GetWindowLongPtrW(receiver.hwnd, GWL_STYLE) & BS_TYPEMASK;
    require(style == BS_PUSHBUTTON || style == BS_DEFPUSHBUTTON ||
      (style == BS_OWNERDRAW && receiver.className.starts_with(L"WindowsForms10.BUTTON.")), "unsupported_action");
    auto parent = GetParent(receiver.hwnd);
    DWORD parentPid = 0;
    auto parentThread = GetWindowThreadProcessId(parent, &parentPid);
    require(parentThread == receiver.threadId && parentPid == receiver.root.process->pid &&
      (parent == receiver.root.hwnd || IsChild(receiver.root.hwnd, parent)), "target_changed");
    std::optional<WindowReceiver> parentReceiver;
    if (parent != receiver.root.hwnd) parentReceiver = registry.receiver(receiver.root, parent);
    std::lock_guard lock(gate);
    permit(); registry.validate(receiver);
    if (parentReceiver) registry.validate(*parentReceiver);
    require(GetParent(receiver.hwnd) == parent, "target_changed");
    DWORD_PTR returned = 0;
    dispatched = true;
    require(SendMessageTimeoutW(parent, WM_COMMAND, MAKEWPARAM(GetDlgCtrlID(receiver.hwnd), BN_CLICKED),
      reinterpret_cast<LPARAM>(receiver.hwnd), SMTO_ABORTIFHUNG | SMTO_BLOCK, 250, &returned) != 0, "execution_uncertain");
    permit(); registry.validate(receiver);
    if (parentReceiver) registry.validate(*parentReceiver);
    put(result, "inputAssistance", "win32-button-notification");
    return result;
  }
  // Drag remains a required candidate until a route passes foreground isolation.
  require(method != "drag", "unsupported_action");
  if (method == "type_text") {
    require(editableReceiver(receiver) && IsWindowUnicode(receiver.hwnd), "unsupported_action");
    auto value = wide(text(args, "text", 16384));
    for (auto character : value) require(character >= 0x20 || character == L'\r' || character == L'\n', "unsupported_action");
    for (uint32_t index = 0; index < value.size(); ++index) {
      auto character = value[index];
      require(character >= 0x20 || character == L'\r' || character == L'\n', "unsupported_action");
      if (character == L'\r' && index + 1 < value.size() && value[index + 1] == L'\n') ++index;
      if (character == L'\n') character = L'\r';
      send(registry, receiver, WM_CHAR, character, 1, gate, permit);
    }
    return result;
  }
  if (method == "press_keys") {
    require(editableReceiver(receiver), "unsupported_action");
    auto combination = text(args, "combination", 32);
    if (combination == "CTRL+A") {
      send(registry, receiver, EM_SETSEL, 0, -1, gate, permit);
      put(result, "inputAssistance", "win32-edit-selection"); return result;
    }
    require(combination == "ENTER", "unsupported_action");
    auto scan = MapVirtualKeyExW(VK_RETURN, MAPVK_VK_TO_VSC, GetKeyboardLayout(receiver.threadId));
    auto flags = static_cast<LPARAM>(1 | (scan << 16));
    send(registry, receiver, WM_KEYDOWN, VK_RETURN, flags, gate, permit, true);
    send(registry, receiver, WM_KEYUP, VK_RETURN, static_cast<LPARAM>(static_cast<uintptr_t>(flags) | 0xc0000000ULL), gate, permit, false, true);
    return result;
  }
  require(mouseReceiver(receiver), "unsupported_action");
  auto position = clientPosition(receiver, args);
  if (method == "move") { send(registry, receiver, WM_MOUSEMOVE, 0, position, gate, permit); return result; }
  if (method == "scroll") {
    auto deltaY = number(args, "deltaY", -10000, 10000);
    auto deltaX = args.HasKey(L"deltaX") ? number(args, "deltaX", -10000, 10000) : 0;
    auto screenX = number(args, "screenX", SHRT_MIN, SHRT_MAX), screenY = number(args, "screenY", SHRT_MIN, SHRT_MAX);
    auto screen = MAKELPARAM(static_cast<WORD>(screenX), static_cast<WORD>(screenY));
    if (deltaY) send(registry, receiver, WM_MOUSEWHEEL, MAKEWPARAM(0, static_cast<WORD>(-deltaY)), screen, gate, permit);
    if (deltaX) send(registry, receiver, WM_MOUSEHWHEEL, MAKEWPARAM(0, static_cast<WORD>(deltaX)), screen, gate, permit);
    return result;
  }
  throw Error("unsupported_action");
}
}
