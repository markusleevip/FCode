#include "WindowLifecycle.h"
#include <future>

namespace fcode::cua {
namespace { thread_local WindowLifecycle* observer = nullptr; }

WindowLifecycle::WindowLifecycle() : shutdown(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {
  require(shutdown.get() != nullptr, "window_lifecycle_unavailable");
  std::promise<bool> ready;
  auto initialized = ready.get_future();
  thread = std::thread([this, ready = std::move(ready)]() mutable {
    MSG message{};
    PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
    observer = this;
    auto hook = SetWinEventHook(EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY, nullptr, callback,
      0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
    healthy = hook != nullptr;
    ready.set_value(healthy.load());
    if (hook) {
      auto signal = shutdown.get();
      bool running = true;
      while (running && MsgWaitForMultipleObjects(1, &signal, FALSE, INFINITE, QS_ALLINPUT) == WAIT_OBJECT_0 + 1) {
        while (WaitForSingleObject(signal, 0) == WAIT_TIMEOUT && PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
          if (message.message == WM_QUIT) { running = false; break; }
          TranslateMessage(&message);
          DispatchMessageW(&message);
        }
      }
      UnhookWinEvent(hook);
    }
    observer = nullptr;
    healthy = false;
  });
  if (!initialized.get()) {
    thread.join();
    throw Error("window_lifecycle_unavailable");
  }
}
WindowLifecycle::~WindowLifecycle() {
  healthy = false;
  if (thread.joinable()) {
    SetEvent(shutdown.get());
    thread.join();
  }
}
void CALLBACK WindowLifecycle::callback(HWINEVENTHOOK, DWORD event, HWND hwnd, LONG object, LONG child, DWORD, DWORD) {
  if (observer && hwnd && object == OBJID_WINDOW && child == CHILDID_SELF &&
      (event == EVENT_OBJECT_CREATE || event == EVENT_OBJECT_DESTROY)) observer->invalidate(hwnd);
}
void WindowLifecycle::invalidate(HWND hwnd) {
  std::lock_guard lock(mutex);
  auto found = generations.find(hwnd);
  if (found == generations.end()) return;
  if (nextGeneration >= SafeInteger) { healthy = false; return; }
  found->second = nextGeneration++;
}
uint64_t WindowLifecycle::watch(HWND hwnd) {
  std::lock_guard lock(mutex);
  require(healthy.load(), "window_lifecycle_unavailable");
  auto found = generations.find(hwnd);
  if (found != generations.end()) return found->second;
  require(generations.size() < 4096 && nextGeneration < SafeInteger, "resource_limit");
  auto value = nextGeneration++;
  generations.emplace(hwnd, value);
  return value;
}
uint64_t WindowLifecycle::generation(HWND hwnd) {
  std::lock_guard lock(mutex);
  require(healthy.load(), "window_lifecycle_unavailable");
  auto found = generations.find(hwnd);
  require(found != generations.end(), "target_changed");
  return found->second;
}
void WindowLifecycle::retain(std::unordered_set<HWND> const& current) {
  std::lock_guard lock(mutex);
  require(healthy.load(), "window_lifecycle_unavailable");
  std::erase_if(generations, [&](auto const& pair) { return !current.contains(pair.first); });
}
}
