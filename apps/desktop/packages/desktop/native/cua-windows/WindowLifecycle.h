#pragma once
#include "HostIdentity.h"
#include <atomic>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <unordered_set>

namespace fcode::cua {
class WindowLifecycle {
public:
  WindowLifecycle();
  ~WindowLifecycle();
  uint64_t watch(HWND hwnd);
  uint64_t generation(HWND hwnd);
  void retain(std::unordered_set<HWND> const& current);
private:
  static void CALLBACK callback(HWINEVENTHOOK, DWORD, HWND, LONG, LONG, DWORD, DWORD);
  void invalidate(HWND hwnd);
  std::mutex mutex;
  std::unordered_map<HWND, uint64_t> generations;
  uint64_t nextGeneration = 1;
  std::atomic<bool> healthy = false;
  Handle shutdown;
  std::thread thread;
};
}
