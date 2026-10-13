# Stockfish.js 18 (lite, single-threaded)

The eval bar on the game page runs this engine in the viewer's browser.

- Source: the `stockfish` npm package, version 18.0.8 (`bin/stockfish-18-lite-single.js` and `.wasm`),
  built from https://github.com/nmrugg/stockfish.js, which is based on https://github.com/official-stockfish/Stockfish.
- License: GPLv3, see COPYING.txt. The engine's source code is available at the links above.

The single-threaded build runs without the cross-origin isolation headers that the multi-threaded one needs.
