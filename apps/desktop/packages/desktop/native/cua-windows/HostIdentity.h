#pragma once
#include "NativeJson.h"
#include <windows.h>
#include <string>
#include <vector>

namespace fcode::cua {
class Handle {
public:
  explicit Handle(HANDLE value = nullptr) : value(value) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(Handle const&) = delete;
  Handle& operator=(Handle const&) = delete;
  HANDLE get() const { return value; }
private:
  HANDLE value;
};
class HostIdentity {
public:
  void authenticate(Json const& params);
  bool alive() const;
  bool isControlClient(HANDLE pipe) const;
  std::wstring logonSid() const;
  uint64_t pid() const { return parentPid; }
  ~HostIdentity();
private:
  HANDLE parent = nullptr;
  DWORD parentPid = 0;
};
bool interactiveDesktop();
DWORD windowsBuild();
}
