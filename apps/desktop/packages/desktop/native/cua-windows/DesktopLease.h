#pragma once
#include "HostIdentity.h"
#include <memory>

namespace fcode::cua {
class DesktopLease {
public:
  void acquire(std::wstring const& logonSid);
  bool owned() const { return journal != nullptr; }
  void beginInput();
  void confirmInput();
  void release() { journal.reset(); }
private:
  void write(bool pending);
  std::unique_ptr<Handle> journal;
};
}
