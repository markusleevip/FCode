#pragma once
#include "WindowRegistry.h"
#include <functional>

namespace fcode::cua {
int uiaObserverMain(bool input = false);
Json observeUia(WindowIdentity const& window, std::function<bool()> const& live);
Json executeUia(WindowIdentity const& window, Json const& work, HANDLE cancellation, std::function<bool()> const& live);
}
