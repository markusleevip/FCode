#pragma once
#include "WindowRegistry.h"
#include <functional>
#include <span>

namespace fcode::cua {
struct CapturedWindow {
  uint32_t width;
  uint32_t height;
  uint32_t sourceWidth;
  uint32_t sourceHeight;
  std::string png;
};
CapturedWindow captureWindow(WindowIdentity const& window, std::function<bool()> const& live);
CapturedWindow encodePng(uint32_t width, uint32_t height, std::span<const uint8_t> pixels);
}
