#pragma once
#include "WindowCapture.h"
#include <atomic>
#include <future>
#include <mutex>
#include <optional>
#include <thread>

namespace fcode::cua {
struct DesktopDisplay { HMONITOR handle; RECT bounds; std::wstring device; std::string id; bool primary; };
struct DesktopFrame {
  std::string id, scope, topology;
  uint64_t epoch, activity;
  ULONGLONG expires;
  DesktopDisplay display;
  uint32_t width, height;
  HWND foreground, focus;
  DWORD pid;
  FILETIME creation;
};
class DesktopControl {
public:
  ~DesktopControl();
  Json displays();
  void begin(std::string scope, std::string displayId, uint64_t epoch, DWORD hostPid);
  Json capture(std::string const& scope, uint64_t epoch, Json const& arguments,
    std::mutex& gate, std::function<void()> const& permit);
  Json execute(std::string const& scope, uint64_t epoch, std::string const& method, Json const& arguments,
    std::mutex& gate, std::function<void()> const& permit);
  bool release();
  void stop();
  bool wasDispatched() const { return dispatched; }
  bool interrupted() const { return paused.load(); }
private:
  static LRESULT CALLBACK keyboardHook(int code, WPARAM message, LPARAM data);
  void startHooks();
  void endHooks();
  void validateScope(std::string const& scope, uint64_t epoch);
  void validateWindow(HWND hwnd);
  void send(std::vector<INPUT> const& values, std::mutex& gate, std::function<void()> const& permit);
  POINT point(DesktopFrame const& frame, Json const& args, std::string_view x, std::string_view y);
  void checkFrame(DesktopFrame const& frame, bool keyboard);
  void move(POINT point, std::mutex& gate, std::function<void()> const& permit);
  void mask(std::vector<uint8_t>& pixels, DesktopDisplay const& display);
  bool privateWindow(HWND hwnd);
  std::string scopeId, displayId, scopeTopology;
  uint64_t scopeEpoch = 0;
  DWORD hostPid = 0;
  std::wstring hostImage;
  std::optional<DesktopFrame> frame;
  std::vector<INPUT> held;
  std::atomic<uint64_t> activity = 0;
  std::atomic<bool> paused = true;
  std::atomic<DWORD> hookThreadId = 0;
  std::thread hooks;
  bool dispatched = false;
  static std::atomic<DesktopControl*> hookOwner;
  static constexpr ULONG_PTR InputTag = 0x46435541;
};
std::vector<DesktopDisplay> desktopDisplays();
std::string desktopTopology(std::vector<DesktopDisplay> const& displays);
CapturedWindow captureDesktopMonitor(DesktopDisplay const& display, std::function<bool()> const& live,
  std::function<void(std::vector<uint8_t>&)> const& mask);
}
