#pragma once
#include "HostIdentity.h"
#include "WindowLifecycle.h"
#include <memory>
#include <unordered_map>
#include <vector>

namespace fcode::cua {
struct ProcessIdentity {
  std::shared_ptr<Handle> process;
  DWORD pid;
  std::string instanceId;
  std::string appId;
  std::wstring path;
};
struct WindowIdentity {
  std::shared_ptr<ProcessIdentity> process;
  HWND hwnd;
  uint64_t id;
  uint64_t generation;
  DWORD threadId;
};
struct WindowReceiver {
  WindowIdentity root;
  HWND hwnd;
  DWORD threadId;
  uint64_t generation;
  std::wstring className;
};
class WindowRegistry {
public:
  explicit WindowRegistry(DWORD hostPid);
  Json applications();
  Json windows(Json const& target);
  Json resolve(Json const& target);
  WindowIdentity window(Json const& target);
  WindowReceiver receiver(WindowIdentity const& root, HWND hwnd);
  WindowReceiver hit(WindowIdentity const& root, POINT screen);
  void validate(WindowReceiver const& receiver);
private:
  void refresh();
  std::shared_ptr<ProcessIdentity> process(DWORD pid);
  Json describe(WindowIdentity const& value, bool geometry);
  DWORD hostPid;
  std::wstring hostImage;
  WindowLifecycle lifecycle;
  uint64_t nextWindowId = 1;
  std::unordered_map<DWORD, std::shared_ptr<ProcessIdentity>> processes;
  std::unordered_map<uint64_t, WindowIdentity> registered;
  std::unordered_map<HWND, WindowReceiver> receivers;
};
}
