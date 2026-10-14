#include "Supervisor.h"
#include "HostRole.h"
#include "UiaObserver.h"
#ifdef GetObject
#undef GetObject
#endif
#include <sddl.h>
#include <iostream>
#include <functional>
#include <charconv>
#include <climits>

namespace fcode::cua {
namespace {
bool finishIo(HANDLE handle, OVERLAPPED& operation, DWORD& transferred, std::function<bool()> const& live) {
  while (live()) {
    auto wait = WaitForSingleObject(operation.hEvent, 100);
    if (wait == WAIT_OBJECT_0) return GetOverlappedResult(handle, &operation, &transferred, FALSE) != FALSE;
    if (wait != WAIT_TIMEOUT) break;
  }
  CancelIoEx(handle, &operation);
  // Cancellation completes before the OVERLAPPED/event storage goes out of scope.
  GetOverlappedResult(handle, &operation, &transferred, TRUE);
  return false;
}
bool pipeIo(HANDLE handle, void* bytes, DWORD size, DWORD& transferred, bool writing, std::function<bool()> const& live) {
  Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); if (!event.get()) return false;
  OVERLAPPED operation{}; operation.hEvent = event.get();
  bool completed = (writing ? WriteFile(handle, bytes, size, &transferred, &operation) : ReadFile(handle, bytes, size, &transferred, &operation)) != FALSE;
  if (completed) return true;
  if (GetLastError() != ERROR_IO_PENDING) return false;
  return finishIo(handle, operation, transferred, live);
}
bool writeLine(HANDLE handle, Json const& value, std::function<bool()> const& live) {
  auto bytes = stringify(value) + "\n"; DWORD written = 0;
  return bytes.size() <= ControlBytes && pipeIo(handle, bytes.data(), static_cast<DWORD>(bytes.size()), written, true, live) && written == bytes.size();
}
}
Supervisor::Supervisor() : engineInstanceId(randomHex()) {}
Supervisor::~Supervisor() {
  closing = true;
  if (controlPipe != INVALID_HANDLE_VALUE) CancelIoEx(controlPipe, nullptr);
  if (controlThread.joinable()) controlThread.join();
  if (controlPipe != INVALID_HANDLE_VALUE) { DisconnectNamedPipe(controlPipe); CloseHandle(controlPipe); }
  SecureZeroMemory(secret.data(), secret.size());
}
Json Supervisor::status() const {
  Json result; put(result, "platform", "win32");
#ifdef _M_ARM64
  put(result, "arch", "arm64");
#else
  put(result, "arch", "x64");
#endif
  put(result, "osBuild", uint64_t{windowsBuild()}); put(result, "nativeProtocolVersion", uint64_t{2});
  put(result, "engineInstanceId", engineInstanceId); put(result, "helperPid", uint64_t{GetCurrentProcessId()});
  put(result, "hostRole", hostRole());
  putBool(result, "interactiveDesktop", interactiveDesktop());
  putBool(result, "desktopInterrupted", desktop.interrupted());
  JsonArray capabilities;
  capabilities.Append(JsonValue::CreateStringValue(L"uia-observation"));
  capabilities.Append(JsonValue::CreateStringValue(L"win32-window-messages"));
  capabilities.Append(JsonValue::CreateStringValue(L"application-window-ui"));
  capabilities.Append(JsonValue::CreateStringValue(L"desktop-lease-journal"));
  capabilities.Append(JsonValue::CreateStringValue(L"desktop-monitor-capture"));
  capabilities.Append(JsonValue::CreateStringValue(L"win32-send-input"));
  result.Insert(L"capabilities", capabilities); return result;
}
Json Supervisor::hello(Json const& params) {
  exact(params, {"secret", "nonce", "parentPid", "parentImageSha256"}, {"secret", "nonce", "parentPid", "parentImageSha256"});
  require(registry == nullptr, "identity_invalid");
  auto candidateSecret = unhex(text(params, "secret", 64)); auto candidateNonce = text(params, "nonce", 64); unhex(candidateNonce);
  host.authenticate(params); secret = std::move(candidateSecret); nonce = std::move(candidateNonce);
  auto pipeName = L"\\\\.\\pipe\\fcode-cua-" + std::wstring(wide(nonce));
  auto descriptorText = L"D:P(A;;GA;;;" + host.logonSid() + L")";
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  require(ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptorText.c_str(), SDDL_REVISION_1, &descriptor, nullptr), "identity_invalid");
  SECURITY_ATTRIBUTES security{ sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE };
  controlPipe = CreateNamedPipeW(pipeName.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1,
    static_cast<DWORD>(ControlBytes), static_cast<DWORD>(ControlBytes), 0, &security);
  LocalFree(descriptor); require(controlPipe != INVALID_HANDLE_VALUE, "identity_invalid");
  registry = std::make_unique<WindowRegistry>(static_cast<DWORD>(host.pid()));
  controlThread = std::thread([this] { serveControl(); });
  Json result; result.Insert(L"status", status()); put(result, "nonce", nonce); put(result, "controlPipe", utf8(winrt::hstring(pipeName))); return result;
}
void Supervisor::checkLease(uint64_t requested) {
  require(host.alive(), "not_authorized"); require(interactiveDesktop(), "desktop_locked");
  require(!closing && desktopLease.owned() && requested == epoch && leaseDeadline > GetTickCount64(), "not_authorized");
}
void Supervisor::expireLease() {
  std::lock_guard lock(state);
  if (!desktopLease.owned() || leaseDeadline > GetTickCount64()) return;
  leaseDeadline = 0; reservations.clear();
  if (activeInput || inputUncertain) {
    inputUncertain = true;
    if (inputCancellation) SetEvent(inputCancellation->get());
    return;
  }
  desktop.stop();
  if (!registry || !messages.release(*registry) || !desktop.release()) { inputUncertain = true; desktopLease.beginInput(); return; }
  keyboardReceivers.clear(); desktopLease.release();
}
Json Supervisor::reserve(Json const& params) {
  exact(params, {"actionDigest", "epoch", "ttlMs"}, {"actionDigest", "epoch", "ttlMs"});
  auto requested = static_cast<uint64_t>(number(params, "epoch")); auto ttl = number(params, "ttlMs", 1, 1000);
  auto digest = text(params, "actionDigest", 64); unhex(digest);
  std::lock_guard lock(state); checkLease(requested);
  auto now = GetTickCount64(); std::erase_if(reservations, [&](auto const& pair) { return pair.second.deadline <= now; });
  require(reservations.size() < 16, "control_busy"); auto id = randomHex();
  reservations.emplace(id, Reservation{ digest, requested, now + ttl });
  Json result; put(result, "reservationId", id); put(result, "engineInstanceId", engineInstanceId);
  put(result, "epoch", requested); put(result, "expiresInMs", static_cast<uint64_t>(ttl)); return result;
}
Json Supervisor::execute(Json const& params) {
  exact(params, {"payload", "mac"}, {"payload", "mac"});
  auto payloadText = text(params, "payload", RequestBytes); auto mac = text(params, "mac", 64); unhex(mac);
  require(constantEqual(hmac(secret, payloadText), mac), "not_authorized"); auto payload = parse(payloadText);
  exact(payload, {"reservationId", "actionJson", "actionDigest", "epoch", "revision", "callId", "target", "observationId", "desktopScope"},
    {"reservationId", "actionJson", "actionDigest", "epoch", "revision", "callId"});
  auto requested = static_cast<uint64_t>(number(payload, "epoch")); number(payload, "revision", 0); text(payload, "callId", 128);
  auto actionBytes = text(payload, "actionJson", RequestBytes); auto digest = sha256({ reinterpret_cast<const uint8_t*>(actionBytes.data()), actionBytes.size() });
  require(constantEqual(digest, text(payload, "actionDigest", 64)), "not_authorized");
  {
    std::lock_guard lock(state); checkLease(requested);
    auto found = reservations.find(text(payload, "reservationId", 128));
    require(found != reservations.end() && found->second.epoch == requested && found->second.deadline > GetTickCount64() && constantEqual(found->second.digest, digest), "not_authorized");
    reservations.erase(found);
  }
  auto action = parse(actionBytes); exact(action, {"schemaVersion", "actionId", "method", "params"}, {"schemaVersion", "actionId", "method", "params"});
  auto schema = number(action, "schemaVersion", 1, 2); auto actionId = text(action, "actionId", 128); auto method = text(action, "method", 64); auto arguments = object(action, "params");
  require((schema == 2) == method.starts_with("desktop_"));
  {
    std::lock_guard lock(state); checkLease(requested);
    require(!consumedActions.contains(actionId), "not_authorized");
    require(consumedActions.size() < 512, "resource_limit");
    consumedActions.insert(actionId);
  }
  // Product capabilities remain gated; internal input prototypes are separately verified.
  if (schema == 2) return desktopAction(payload, arguments, method, requested);
  require(!payload.HasKey(L"desktopScope"), "not_authorized");
  if (method == "list_apps") { exact(arguments, {}, {}); return registry->applications(); }
  if (method == "list_windows") {
    exact(arguments, {"appId", "pid"}, {"appId", "pid"}); require(payload.HasKey(L"target"), "not_authorized");
    auto target = object(payload, "target");
    require(text(target, "appId") == text(arguments, "appId") && number(target, "pid") == number(arguments, "pid"), "not_authorized"); return registry->windows(target);
  }
  if (method == "capture" || method == "get_app_state") {
    exact(arguments, {"appId", "pid", "windowId"}, {"appId", "pid", "windowId"});
    require(payload.HasKey(L"target"), "not_authorized"); auto target = object(payload, "target");
    require(text(target, "appId") == text(arguments, "appId") && number(target, "pid") == number(arguments, "pid") &&
      number(target, "windowId") == number(arguments, "windowId"), "not_authorized");
    auto live = [this, requested] { try { std::lock_guard lock(state); checkLease(requested); return true; } catch (...) { return false; } };
    return observations.capture(*registry, target, requested, live, false, method == "get_app_state");
  }
  if (method == "element_action") return elementAction(payload, arguments, requested);
  if (method == "click" || method == "move" || method == "scroll" || method == "drag" || method == "type_text" || method == "press_keys") return messageAction(payload, arguments, method, requested);
  throw Error("unsupported_action");
}
Json Supervisor::desktopAction(Json const& payload, Json const& args, std::string const& method, uint64_t requested) {
  require(payload.HasKey(L"desktopScope") && !payload.HasKey(L"target"), "not_authorized");
  auto scope = text(payload, "desktopScope", 128);
  auto permit = [this, requested] { checkLease(requested); require(!inputUncertain, "execution_uncertain"); };
  if (method == "desktop_get_state") return desktop.capture(scope, requested, args, state, permit);
  require(method == "desktop_click" || method == "desktop_move" || method == "desktop_scroll" || method == "desktop_drag" ||
    method == "desktop_type_text" || method == "desktop_press_keys", "unsupported_action");
  { std::lock_guard lock(state); permit(); require(!activeInput, "control_busy");
    desktopLease.beginInput(); activeInput = true; messageActorActive = true;
  }
  try {
    auto result = desktop.execute(scope, requested, method, args, state, permit);
    std::lock_guard lock(state); permit(); desktopLease.confirmInput(); activeInput = false; messageActorActive = false; return result;
  } catch (...) {
    std::lock_guard lock(state); auto released = desktop.release(); activeInput = false; messageActorActive = false;
    if (desktop.wasDispatched() || !released || inputUncertain) {
      inputUncertain = true; leaseDeadline = 0; reservations.clear(); desktop.stop(); throw Error("execution_uncertain");
    }
    desktopLease.confirmInput(); throw;
  }
}
Json Supervisor::elementAction(Json const& payload, Json const& arguments, uint64_t requested) {
  exact(arguments, {"stateId", "elementIndex", "action", "value"}, {"stateId", "elementIndex", "action"});
  auto action = text(arguments, "action", 32);
  require(action == "press" || action == "set_value", "unsupported_action");
  require((action == "set_value") == arguments.HasKey(L"value"));
  if (arguments.HasKey(L"value")) text(arguments, "value", 16384);
  require(payload.HasKey(L"target") && payload.HasKey(L"observationId"), "not_authorized");
  auto target = object(payload, "target"); auto stateId = text(arguments, "stateId", 128);
  require(text(payload, "observationId", 128) == stateId, "not_authorized");
  auto observation = observations.find(*registry, stateId, target, requested);
  auto index = static_cast<uint32_t>(number(arguments, "elementIndex", 0, 299));
  require(index < observation.elements.Size() && index < observation.bindings.Size(), "invalid_request");
  auto element = observation.elements.GetAt(index).GetObject();
  require(!boolean(element, "isPassword"), "sensitive_target"); require(boolean(element, "enabled"), "unsupported_action");
  auto runtimeId = utf8(observation.bindings.GetAt(index).GetString());
  require(!runtimeId.empty() && runtimeId.size() <= 2048, "unsupported_action");
  auto window = registry->window(target);
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  auto cancellation = std::make_shared<Handle>(CreateEventW(&security, TRUE, FALSE, nullptr));
  require(cancellation->get() != nullptr, "backend_unavailable");
  Json work; put(work, "runtimeId", runtimeId); put(work, "action", action);
  if (arguments.HasKey(L"value")) put(work, "value", text(arguments, "value", 16384));
  {
    std::lock_guard lock(state); checkLease(requested);
    require(!inputUncertain && !activeInput, "execution_uncertain");
    put(work, "deadline", leaseDeadline);
    desktopLease.beginInput(); activeInput = true; inputCancellation = cancellation;
  }
  auto live = [this, requested] { try { std::lock_guard lock(state); checkLease(requested); return true; } catch (...) { return false; } };
  bool providerReturned = false;
  try {
    observations.consumeWindow(observation);
    auto result = executeUia(window, work, cancellation->get(), live);
    providerReturned = true;
    require(live(), "execution_uncertain");
    auto current = object(registry->resolve(target), "target");
    require(text(current, "instanceId", 256) == text(observation.target, "instanceId", 256) &&
      number(current, "windowId") == number(observation.target, "windowId") &&
      text(current, "topologyVersion", 256) == text(observation.target, "topologyVersion", 256), "execution_uncertain");
    std::optional<WindowReceiver> prepared;
    if (result.HasKey(L"receiver")) { prepared = preparedReceiver(window, result); result.Remove(L"receiver"); }
    std::lock_guard lock(state); checkLease(requested);
    if (prepared) keyboardReceivers.insert_or_assign(window.id, *prepared);
    desktopLease.confirmInput(); activeInput = false; inputCancellation.reset();
    return result;
  } catch (Error const& error) {
    std::lock_guard lock(state);
    activeInput = false; inputCancellation.reset();
    bool known = !providerReturned && (error.code == "unsupported_action" || error.code == "sensitive_target" || error.code == "observation_stale" || error.code == "target_access_denied");
    if (!known || inputUncertain) { inputUncertain = true; leaseDeadline = 0; reservations.clear(); throw Error("execution_uncertain"); }
    desktopLease.confirmInput();
    throw;
  } catch (...) {
    std::lock_guard lock(state); activeInput = false; inputCancellation.reset(); inputUncertain = true; leaseDeadline = 0; reservations.clear();
    throw Error("execution_uncertain");
  }
}
WindowReceiver Supervisor::preparedReceiver(WindowIdentity const& root, Json const& result) {
  auto value = object(result, "receiver"); exact(value, {"hwnd", "threadId"}, {"hwnd", "threadId"});
  auto raw = text(value, "hwnd", 32); uintptr_t address = 0;
  auto parsed = std::from_chars(raw.data(), raw.data() + raw.size(), address);
  require(parsed.ec == std::errc{} && parsed.ptr == raw.data() + raw.size() && address != 0, "protocol_invalid");
  auto receiver = registry->receiver(root, reinterpret_cast<HWND>(address));
  require(receiver.threadId == number(value, "threadId", 1, MAXDWORD), "target_changed"); return receiver;
}
Json Supervisor::messageAction(Json const& payload, Json const& args, std::string const& method, uint64_t requested) {
  auto pointer = method == "click" || method == "move" || method == "scroll" || method == "drag";
  if (method == "click") exact(args, {"frameId", "x", "y", "button", "count"}, {"frameId", "x", "y"});
  if (method == "move") exact(args, {"frameId", "x", "y"}, {"frameId", "x", "y"});
  if (method == "scroll") exact(args, {"frameId", "x", "y", "deltaX", "deltaY"}, {"frameId", "x", "y", "deltaY"});
  if (method == "drag") exact(args, {"frameId", "x", "y", "toX", "toY", "durationMs"}, {"frameId", "x", "y", "toX", "toY"});
  if (method == "type_text") exact(args, {"stateId", "text", "elementIndex"}, {"stateId", "text"});
  if (method == "press_keys") exact(args, {"stateId", "keys"}, {"stateId", "keys"});
  require(payload.HasKey(L"target") && payload.HasKey(L"observationId"), "not_authorized");
  auto target = object(payload, "target"); auto id = text(args, pointer ? "frameId" : "stateId", 128);
  require(id == text(payload, "observationId", 128), "not_authorized");
  auto observation = observations.find(*registry, id, target, requested);
  auto window = registry->window(target);
  Json normalized = args;
  std::optional<WindowReceiver> selected;
  auto region = object(observation.target, "region");
  auto point = [&](std::string_view xKey, std::string_view yKey) {
    auto x = number(args, xKey, 0, observation.width - 1), y = number(args, yKey, 0, observation.height - 1);
    return POINT{static_cast<LONG>(number(region, "x", LONG_MIN, LONG_MAX) + x * number(region, "width") / observation.width),
      static_cast<LONG>(number(region, "y", LONG_MIN, LONG_MAX) + y * number(region, "height") / observation.height)};
  };
  if (pointer) {
    auto screen = point("x", "y");
    selected = registry->hit(window, screen);
    normalized.Insert(L"screenX", JsonValue::CreateNumberValue(screen.x)); normalized.Insert(L"screenY", JsonValue::CreateNumberValue(screen.y));
    if (method == "drag") {
      auto end = point("toX", "toY"); normalized.Insert(L"endX", JsonValue::CreateNumberValue(end.x)); normalized.Insert(L"endY", JsonValue::CreateNumberValue(end.y));
      if (!args.HasKey(L"durationMs")) put(normalized, "durationMs", uint64_t{300});
    }
  } else if (method == "type_text" && args.HasKey(L"elementIndex")) {
    auto index = static_cast<uint32_t>(number(args, "elementIndex", 0, 299));
    require(index < observation.elements.Size() && index < observation.bindings.Size(), "invalid_request");
    require(!boolean(observation.elements.GetAt(index).GetObject(), "isPassword"), "sensitive_target");
    auto runtimeId = utf8(observation.bindings.GetAt(index).GetString()); require(!runtimeId.empty(), "unsupported_action");
    Json work; put(work, "runtimeId", runtimeId); put(work, "action", "prepare");
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    Handle cancel(CreateEventW(&security, TRUE, FALSE, nullptr)); require(cancel.get() != nullptr, "backend_unavailable");
    auto live = [this, requested] { try { std::lock_guard lock(state); checkLease(requested); return true; } catch (...) { return false; } };
    { std::lock_guard lock(state); checkLease(requested); put(work, "deadline", leaseDeadline); }
    selected = preparedReceiver(window, executeUia(window, work, cancel.get(), live));
  } else {
    std::lock_guard lock(state); checkLease(requested);
    auto found = keyboardReceivers.find(window.id); require(found != keyboardReceivers.end(), "unsupported_action"); selected = found->second;
  }
  if (method == "press_keys") {
    auto keys = args.Lookup(L"keys"); require(keys.ValueType() == JsonType::Array && keys.GetArray().Size() >= 1 && keys.GetArray().Size() <= 8);
    std::vector<std::string> names;
    for (auto const& key : keys.GetArray()) { require(key.ValueType() == JsonType::String); names.push_back(utf8(key.GetString())); }
    if (names == std::vector<std::string>{"ENTER"} || names == std::vector<std::string>{"RETURN"}) put(normalized, "combination", "ENTER");
    else if (names == std::vector<std::string>{"CTRL", "A"}) put(normalized, "combination", "CTRL+A");
    else throw Error("unsupported_action");
  }
  auto receiver = *selected; registry->validate(receiver);
  { std::lock_guard lock(state); checkLease(requested); require(!inputUncertain && !activeInput, "execution_uncertain"); desktopLease.beginInput(); activeInput = true; messageActorActive = true; }
  auto permit = [this, requested, target] {
    checkLease(requested);
    auto current = object(registry->resolve(target), "target");
    require(text(current, "topologyVersion", 256) == text(target, "topologyVersion", 256), "observation_stale");
  };
  try {
    observations.consumeWindow(observation);
    auto result = messages.execute(*registry, receiver, method, normalized, state, permit);
    std::lock_guard lock(state); checkLease(requested); desktopLease.confirmInput(); activeInput = false; messageActorActive = false;
    if ((method == "click" || method == "type_text") && editableReceiver(receiver)) keyboardReceivers.insert_or_assign(window.id, receiver);
    return result;
  } catch (...) {
    std::lock_guard lock(state);
    bool released = messages.release(*registry);
    activeInput = false; messageActorActive = false;
    if (messages.wasDispatched() || !released || inputUncertain) { inputUncertain = true; leaseDeadline = 0; reservations.clear(); throw Error("execution_uncertain"); }
    desktopLease.confirmInput();
    throw;
  }
}
Json Supervisor::request(Json const& value) {
  envelope(value); auto method = text(value, "method", 64); auto params = object(value, "params");
  if (method == "hello") return hello(params);
  require(registry != nullptr && host.alive() && !closing, "not_authorized");
  if (method == "status") { exact(params, {}, {}); return status(); }
  if (method == "desktop_displays") { exact(params, {}, {}); return desktop.displays(); }
  if (method == "resolve_target") { exact(params, {"target"}, {"target"}); return registry->resolve(object(params, "target")); }
  if (method == "preview_application_ui" || method == "application_window_ui") return windowUi(params, method == "preview_application_ui");
  if (method == "reserve_action") return reserve(params);
  if (method == "execute") return execute(params);
  throw Error("unsupported_action");
}
Json Supervisor::windowUi(Json const& params, bool preview) {
  if (preview) exact(params, {"target"}, {"target"});
  else exact(params, {"target", "mode"}, {"target", "mode"});
  require(interactiveDesktop(), "desktop_locked");
  auto input = object(params, "target");
  auto target = object(registry->resolve(input), "target");
  auto window = registry->window(target);
  auto currentRead = readGeneration.load();
  auto live = [this, currentRead] { return host.alive() && !closing && interactiveDesktop() && readGeneration.load() == currentRead; };
  if (preview) return observations.capture(*registry, target, 0, live, true, false);
  auto mode = text(params, "mode", 16);
  require(mode == "read" || mode == "background", "unsupported_action");
  require(live(), "canceled");
  DWORD foregroundPid = 0; auto foreground = GetForegroundWindow(); GetWindowThreadProcessId(foreground, &foregroundPid);
  Json result; result.Insert(L"target", target);
  putBool(result, "targetWindowIsForeground", foreground == window.hwnd);
  putBool(result, "targetAppIsForeground", foregroundPid == window.process->pid);
  return result;
}
Json Supervisor::control(Json const& value, bool& authenticated) {
  envelope(value); auto method = text(value, "method", 64); auto params = object(value, "params");
  if (method == "authenticate") {
    exact(params, {"secret", "nonce"}, {"secret", "nonce"});
    require(!authenticated && host.isControlClient(controlPipe) && constantEqual(hex(secret), text(params, "secret", 64)) && constantEqual(nonce, text(params, "nonce", 64)), "identity_invalid");
    authenticated = true; Json result; putBool(result, "authenticated", true); return result;
  }
  require(authenticated && host.isControlClient(controlPipe), "not_authorized");
  std::lock_guard lock(state);
  if (method == "desktop_scope") {
    exact(params, {"scopeId", "displayId", "epoch"}, {"scopeId", "displayId", "epoch"});
    auto requested = static_cast<uint64_t>(number(params, "epoch")); checkLease(requested);
    require(!activeInput && !inputUncertain, "control_busy");
    desktop.begin(text(params, "scopeId", 128), text(params, "displayId", 128), requested, static_cast<DWORD>(host.pid()));
    Json result; put(result, "scopeId", text(params, "scopeId", 128)); put(result, "epoch", requested); return result;
  }
  if (method == "lease") {
    exact(params, {"epoch", "ttlMs"}, {"epoch", "ttlMs"}); auto requested = static_cast<uint64_t>(number(params, "epoch")); auto ttl = number(params, "ttlMs", 1, 10000);
    require(!inputUncertain, "execution_uncertain");
    require(interactiveDesktop(), "desktop_locked"); require(requested > epoch || (requested == epoch && leaseDeadline > GetTickCount64()), "not_authorized");
    try { desktopLease.acquire(host.logonSid()); }
    catch (Error const& error) { if (error.code == "execution_uncertain") inputUncertain = true; throw; }
    epoch = requested; leaseDeadline = GetTickCount64() + ttl; Json result; put(result, "epoch", epoch); return result;
  }
  if (method == "stop") {
    exact(params, {"epoch"}, {"epoch"}); auto requested = static_cast<uint64_t>(number(params, "epoch", 0));
    readGeneration++; epoch = std::max(epoch, requested); leaseDeadline = 0; reservations.clear(); Json result; put(result, "epoch", epoch);
    if (inputCancellation) SetEvent(inputCancellation->get());
    if (activeInput) inputUncertain = true;
    desktop.stop();
    auto released = registry && messages.release(*registry) && desktop.release();
    keyboardReceivers.clear();
    if (!activeInput && !inputUncertain && released) desktopLease.release();
    putBool(result, "dispatchQuiescent", (!activeInput || messageActorActive) && !inputUncertain); putBool(result, "releaseConfirmed", released && (!activeInput || messageActorActive));
    putBool(result, "uncertain", inputUncertain); return result;
  }
  if (method == "close") { exact(params, {}, {}); readGeneration++; closing = true; leaseDeadline = 0; reservations.clear(); desktop.stop(); desktop.release(); if (inputCancellation) SetEvent(inputCancellation->get()); return Json{}; }
  throw Error("invalid_request");
}
void Supervisor::serveControl() {
  winrt::init_apartment(winrt::apartment_type::multi_threaded);
  auto live = [this] {
    try { expireLease(); } catch (...) { closing = true; return false; }
    return !closing && host.alive();
  };
  Handle connectedEvent(CreateEventW(nullptr, TRUE, FALSE, nullptr)); if (!connectedEvent.get()) { closing = true; return; }
  OVERLAPPED connection{}; connection.hEvent = connectedEvent.get(); DWORD transferred = 0;
  bool connected = ConnectNamedPipe(controlPipe, &connection) != FALSE;
  if (!connected) {
    auto error = GetLastError();
    connected = error == ERROR_PIPE_CONNECTED || (error == ERROR_IO_PENDING && finishIo(controlPipe, connection, transferred, live));
  }
  if (!connected || !host.isControlClient(controlPipe)) { closing = true; return; }
  bool authenticated = false; std::string buffer; char chunk[4096]{}; DWORD received = 0;
  while (live() && pipeIo(controlPipe, chunk, sizeof(chunk), received, false, live) && received > 0) {
    buffer.append(chunk, received); if (buffer.size() > ControlBytes) break;
    size_t newline;
    while ((newline = buffer.find('\n')) != std::string::npos) {
      auto line = buffer.substr(0, newline); buffer.erase(0, newline + 1); std::string id = "invalid";
      try { auto value = parse(line, ControlBytes); envelope(value); id = text(value, "id", 128); if (!writeLine(controlPipe, success(id, control(value, authenticated)), live)) { closing = true; break; } }
      catch (Error const& error) { if (!writeLine(controlPipe, failure(id, error.code), live)) { closing = true; break; } }
      catch (...) { writeLine(controlPipe, failure(id, "protocol_invalid"), live); closing = true; break; }
    }
  }
  { std::lock_guard lock(state); leaseDeadline = 0; reservations.clear(); }
  closing = true;
}
}
