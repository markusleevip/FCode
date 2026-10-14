#pragma once
#include "NativeCrypto.h"
#include "HostIdentity.h"
#include "WindowRegistry.h"
#include "ObservationStore.h"
#include "WindowMessageInput.h"
#include "DesktopLease.h"
#include "DesktopControl.h"
#include <atomic>
#include <memory>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <unordered_set>

namespace fcode::cua {
class Supervisor {
public:
  Supervisor();
  ~Supervisor();
  Json request(Json const& value);
  bool stopped() const { return closing.load(); }
private:
  Json hello(Json const& params);
  Json status() const;
  Json reserve(Json const& params);
  Json execute(Json const& params);
  Json elementAction(Json const& payload, Json const& arguments, uint64_t epoch);
  Json messageAction(Json const& payload, Json const& arguments, std::string const& method, uint64_t epoch);
  Json desktopAction(Json const& payload, Json const& arguments, std::string const& method, uint64_t epoch);
  Json windowUi(Json const& params, bool preview);
  WindowReceiver preparedReceiver(WindowIdentity const& root, Json const& result);
  void serveControl();
  Json control(Json const& value, bool& authenticated);
  void checkLease(uint64_t epoch);
  void expireLease();
  struct Reservation { std::string digest; uint64_t epoch; ULONGLONG deadline; };
  HostIdentity host;
  std::unique_ptr<WindowRegistry> registry;
  ObservationStore observations;
  WindowMessageInput messages;
  DesktopLease desktopLease;
  DesktopControl desktop;
  std::unordered_map<uint64_t, WindowReceiver> keyboardReceivers;
  std::vector<uint8_t> secret;
  std::string nonce, engineInstanceId;
  std::unordered_map<std::string, Reservation> reservations;
  std::unordered_set<std::string> consumedActions;
  std::mutex state;
  std::atomic<bool> closing = false;
  std::atomic<uint64_t> readGeneration = 0;
  HANDLE controlPipe = INVALID_HANDLE_VALUE;
  std::thread controlThread;
  uint64_t epoch = 0;
  ULONGLONG leaseDeadline = 0;
  bool activeInput = false;
  bool inputUncertain = false;
  bool messageActorActive = false;
  std::shared_ptr<Handle> inputCancellation;
};
}
