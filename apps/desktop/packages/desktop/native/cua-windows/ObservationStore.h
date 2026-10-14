#pragma once
#include "WindowCapture.h"
#include <unordered_map>

namespace fcode::cua {
struct WindowObservation {
  std::string id;
  Json target;
  uint32_t width;
  uint32_t height;
  ULONGLONG expires;
  uint64_t epoch;
  JsonArray bindings;
  JsonArray elements;
};
class ObservationStore {
public:
  Json capture(WindowRegistry& registry, Json const& target, uint64_t epoch, std::function<bool()> const& live,
    bool previewOnly = false, bool includeElements = false);
  WindowObservation find(WindowRegistry& registry, std::string const& id, Json const& target, uint64_t epoch);
  void clear() { observations.clear(); }
  void consumeWindow(WindowObservation const& observation);
private:
  std::unordered_map<std::string, WindowObservation> observations;
};
}
