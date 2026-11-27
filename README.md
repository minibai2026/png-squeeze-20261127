# png-squeeze-20261127

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/minibai2026/png-squeeze-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/minibai2026/png-squeeze-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A Node program that losslessly recompresses 1280x720 RGBA screenshots into the smallest PNG — palette/grey/RGB(A) colour-type reduction, per-row filter search (minimum-sum, fewest-pairs, brute force) and zlib level 9. Practice-set score 702,340 vs the house baseline's 420,399.

## Run it

```sh
node main.ts
```

Reads `$MAKEFUN_INPUT_DIR` (default `/input`) and writes `$MAKEFUN_OUTPUT_DIR` (default `/output`), one `image.png` per instance, in about 20 seconds for a set of 8.

## How it works

For each screenshot the program tries every viable colour type — palette (in luminance and frequency order), grey, grey+alpha, RGB, RGBA, plus a tRNS-keyed form when the image has exactly one transparent value — filters each candidate's rows by minimum-sum, fewest-pairs, fixed filters and brute force, compresses at zlib level 9, and keeps the smallest encoding. Pure Node built-ins, no dependencies, fully deterministic.

---

<sub>Entered on [make.fun](https://make.fun/?ref=nzpx20bb&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>
