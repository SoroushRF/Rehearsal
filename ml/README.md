# ML track (owner: T4)

Advisory impact model behind `ImpactPort`. It can never release a mandatory hold. Core runs with `alwaysAbstain`.

- Python 3.12 in an isolated venv at `ml/.venv`. Don't use the system Python.
- First model: `Qwen/Qwen3.5-0.8B` BF16 LoRA (fallback `Qwen3-0.6B`), on an RTX 5080 with 16 GB.
- The driver reports CUDA 13.3. Use the torch `cu128` wheels: they are the oldest builds with RTX 50-series (sm_120) kernels; `cu126` and older don't run on this card. Don't copy CUDA 13 examples.
- First gate (T4.5, passed): a 32-case forward/backward pass, adapter weights changed, save and reload, peak memory measured. See `manifests/smoke-2026-10-23.{log,json}`.

Layout: `data/` (generators, split manifests), `train/`, `eval/`, `manifests/` (hashes and logs only, no weights).
Caches (`.cache/`), adapters (`adapters/`) and the venv are gitignored in `ml/.gitignore`.

## Setup and smoke test (WSL2 or Linux, from `ml/`)

```bash
export UV_CACHE_DIR=$PWD/.cache/uv
uv venv .venv --python python3.12
uv pip install --python .venv/bin/python -r pyproject.toml
nvidia-smi && .venv/bin/python -c "import torch; assert torch.cuda.is_available()"
.venv/bin/python -m train.smoke   # exits non-zero without a CUDA GPU
```

`train/smoke.py` keeps Hugging Face and Triton caches under `ml/.cache`. In a sandboxed shell, `nvidia-smi` may report "GPU access blocked"; run it unsandboxed.
