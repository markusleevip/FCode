#include "Supervisor.h"
#include "UiaObserver.h"
#include <fcntl.h>
#include <io.h>
#include <iostream>

int main(int argc, char** argv) {
  if (argc == 2 && std::string_view(argv[1]) == "--uia-observer") return fcode::cua::uiaObserverMain();
  if (argc == 2 && std::string_view(argv[1]) == "--uia-action") return fcode::cua::uiaObserverMain(true);
  if (argc != 1) return 2;
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
    fcode::cua::Supervisor supervisor;
    std::string line;
    while (!supervisor.stopped()) {
      line.clear(); char character = '\0';
      while (std::cin.get(character) && character != '\n') {
        if (line.size() >= fcode::cua::RequestBytes) return 3;
        line += character;
      }
      if (!std::cin && line.empty()) break;
      std::string id = "invalid";
      try {
        auto value = fcode::cua::parse(line); fcode::cua::envelope(value); id = fcode::cua::text(value, "id", 128);
        auto bytes = fcode::cua::stringify(fcode::cua::success(id, supervisor.request(value)));
        fcode::cua::require(bytes.size() <= fcode::cua::ResponseBytes, "resource_limit");
        std::cout << bytes << '\n' << std::flush;
      } catch (fcode::cua::Error const& error) { std::cout << fcode::cua::stringify(fcode::cua::failure(id, error.code)) << '\n' << std::flush; }
      catch (...) { std::cout << fcode::cua::stringify(fcode::cua::failure(id, "protocol_invalid")) << '\n' << std::flush; }
      if (!std::cout) break;
    }
    return 0;
  } catch (...) { return 1; }
}
