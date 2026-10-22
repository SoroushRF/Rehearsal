# ML track (owner: D)

Advisory impact model behind `ImpactPort`. It can never release a mandatory hold. Core runs with `alwaysAbstain`.

- Python 3.12 in an isolated venv: `py -3.12 -m venv ml/.venv`. Don't use the system Python 3.14.
- First model: `Qwen/Qwen3.5-0.8B` BF16 LoRA (fallback `Qwen3-0.6B`), on an RTX 5080 with 16 GB (CUDA 13.3 driver).
- The installed driver supports up to CUDA 12.7, so pick matching torch/Unsloth wheels. Don't copy the CUDA 13 examples.
- First gate: a 32-case forward/backward pass, adapter weights changed, save and reload, peak memory measured.

Layout: `data/` (generators, split manifests), `train/`, `eval/`, `manifests/` (hashes only, no weights).
