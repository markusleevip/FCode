#include "ObservationStore.h"
#include "NativeCrypto.h"
#include "UiaObserver.h"
#include <filesystem>

namespace fcode::cua {
namespace {
bool sameGeometry(Json const& left, Json const& right) {
  return text(left, "instanceId", 256) == text(right, "instanceId", 256) && number(left, "windowId") == number(right, "windowId") &&
    text(left, "topologyVersion", 256) == text(right, "topologyVersion", 256);
}
}
Json ObservationStore::capture(WindowRegistry& registry, Json const& input, uint64_t epoch, std::function<bool()> const& live, bool previewOnly, bool includeElements) {
  auto target = object(registry.resolve(input), "target"); require(target.HasKey(L"windowId"), "invalid_request");
  auto window = registry.window(target); auto image = captureWindow(window, live);
  Json elements; elements.Insert(L"elements", JsonArray{}); elements.Insert(L"bindings", JsonArray{}); putBool(elements, "truncated", false);
  if (includeElements) {
    try { elements = observeUia(window, live); }
    catch (Error const& error) {
      require(live(), "canceled");
      putBool(elements, "truncated", true); put(elements, "reason", error.code);
    }
  }
  require(live(), "canceled");
  auto current = object(registry.resolve(target), "target"); require(sameGeometry(target, current), "observation_stale");
  auto region = object(current, "region");
  // The WGC content must match the independently queried physical window bounds.
  require(number(region, "width") == image.sourceWidth && number(region, "height") == image.sourceHeight, "capture_space_changed");
  Json png; put(png, "mimeType", "image/png"); put(png, "data", image.png);
  if (previewOnly) { Json result; result.Insert(L"image", png); return result; }
  auto now = GetTickCount64(); std::erase_if(observations, [&](auto const& pair) { return pair.second.expires <= now; });
  if (observations.size() >= 32) {
    auto oldest = std::min_element(observations.begin(), observations.end(), [](auto const& left, auto const& right) { return left.second.expires < right.second.expires; });
    observations.erase(oldest);
  }
  auto id = randomHex(); observations.emplace(id, WindowObservation{ id, current, image.width, image.height, now + 15000, epoch,
    elements.Lookup(L"bindings").GetArray(), elements.Lookup(L"elements").GetArray() });
  DWORD foregroundPid = 0; auto foreground = GetForegroundWindow(); GetWindowThreadProcessId(foreground, &foregroundPid);
  Json observation; put(observation, "id", id); observation.Insert(L"target", current);
  observation.Insert(L"region", region); put(observation, "topologyVersion", text(current, "topologyVersion", 256));
  put(observation, "width", uint64_t{image.width}); put(observation, "height", uint64_t{image.height});
  putBool(observation, "targetAppIsForeground", foregroundPid == window.process->pid);
  putBool(observation, "targetWindowIsForeground", foreground == window.hwnd);
  observation.Insert(L"elements", elements.Lookup(L"elements")); putBool(observation, "elementsTruncated", boolean(elements, "truncated"));
  if (elements.HasKey(L"reason")) put(observation, "elementsTruncationReason", text(elements, "reason", 64));
  JsonArray images; images.Append(png); Json result; result.Insert(L"observation", observation); result.Insert(L"images", images);
  Json application; put(application, "name", winrt::to_string(std::filesystem::path(window.process->path).stem().wstring()));
  result.Insert(L"application", application);
  put(result, "frameId", id); put(result, "stateId", id); put(result, "coordinateSpace", "window-image-pixels"); return result;
}
WindowObservation ObservationStore::find(WindowRegistry& registry, std::string const& id, Json const& target, uint64_t epoch) {
  auto found = observations.find(id); require(found != observations.end() && found->second.expires > GetTickCount64() && found->second.epoch == epoch, "observation_stale");
  auto current = object(registry.resolve(target), "target"); require(sameGeometry(found->second.target, current), "observation_stale"); return found->second;
}
void ObservationStore::consumeWindow(WindowObservation const& observation) {
  std::erase_if(observations, [&](auto const& pair) {
    return text(pair.second.target, "instanceId", 256) == text(observation.target, "instanceId", 256) &&
      number(pair.second.target, "windowId") == number(observation.target, "windowId");
  });
}
}
