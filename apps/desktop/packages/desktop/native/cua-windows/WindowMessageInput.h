#pragma once
#include "WindowRegistry.h"
#include <functional>
#include <mutex>
#include <optional>

namespace fcode::cua {
class WindowMessageInput {
public:
  Json execute(WindowRegistry& registry, WindowReceiver const& receiver, std::string const& method, Json const& arguments,
    std::mutex& gate, std::function<void()> const& permit);
  bool release(WindowRegistry& registry);
  bool wasDispatched() const { return dispatched; }
private:
  struct Held { WindowReceiver receiver; UINT message; WPARAM key; LPARAM position; };
  void send(WindowRegistry& registry, WindowReceiver const& receiver, UINT message, WPARAM key, LPARAM position,
    std::mutex& gate, std::function<void()> const& permit, bool down = false, bool up = false);
  std::optional<Held> held;
  bool dispatched = false;
};
bool editableReceiver(WindowReceiver const& receiver);
}
