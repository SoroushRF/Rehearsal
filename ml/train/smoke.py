"""T4.5 smoke test: LoRA steps on 32 synthetic cases, then save, reload and compare.

Run from ml/: `.venv/bin/python -m train.smoke`. Refuses to run without a CUDA GPU.
Writes `manifests/smoke-<date>.log` and `.json`. The adapter itself goes to `adapters/` and is
never committed; only its hash is.
"""

import os
from pathlib import Path

ML = Path(__file__).resolve().parents[1]
# Keep every download and compile cache inside ml/.cache, never in the home directory.
os.environ.setdefault("HF_HOME", str(ML / ".cache" / "hf"))
os.environ.setdefault("XDG_CACHE_HOME", str(ML / ".cache"))
os.environ.setdefault("TRITON_CACHE_DIR", str(ML / ".cache" / "triton"))

import hashlib  # noqa: E402
import json  # noqa: E402
import logging  # noqa: E402
import platform  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
from datetime import datetime  # noqa: E402

import peft  # noqa: E402
import torch  # noqa: E402
import transformers  # noqa: E402
from peft import LoraConfig, PeftModel, get_peft_model, get_peft_model_state_dict  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402

from data.smoke_cases import LABELS, cases_sha256, smoke_cases  # noqa: E402

MODELS = [
    ("Qwen/Qwen3.5-0.8B", "2fc06364715b967f1860aea9cf38778875588b17"),
    ("Qwen/Qwen3-0.6B", "c1899de289a04d12100db370d81485cdf75e47ca"),  # fallback
]
LORA = {
    "r": 16,
    "lora_alpha": 32,
    "lora_dropout": 0.0,
    # Full-attention layers, Gated DeltaNet (linear-attention) layers, and the MLP.
    "target_modules": ["q_proj", "k_proj", "v_proj", "o_proj", "in_proj_qkv", "in_proj_z", "out_proj",
                       "gate_proj", "up_proj", "down_proj"],
}
STEPS = 2  # LoRA B starts at zero, so A only receives a gradient from the second step on.
MICRO_BATCH = 8
LR = 1e-4
SEED = 0
SYSTEM = (
    "You classify how a change seen after approval affects one planned billing step. "
    f"Answer with exactly one label: {', '.join(LABELS)}."
)

log = logging.getLogger("smoke")


def mib(n: int) -> float:
    return round(n / 2**20, 1)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_base(model_id: str, revision: str):
    tok = AutoTokenizer.from_pretrained(model_id, revision=revision)
    model = AutoModelForCausalLM.from_pretrained(model_id, revision=revision, dtype=torch.bfloat16).to("cuda")
    return tok, model


def encode(tok, cases: list[dict]) -> list[dict]:
    eos = tok.eos_token or "<|im_end|>"
    rows = []
    for c in cases:
        user = json.dumps({"stepId": c["stepId"], "step": c["step"], "change": c["change"]}, sort_keys=True)
        prompt = tok.apply_chat_template(
            [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}],
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        )
        p = tok(prompt, add_special_tokens=False)["input_ids"]
        a = tok(c["label"] + eos, add_special_tokens=False)["input_ids"]
        rows.append({"input_ids": p + a, "labels": [-100] * len(p) + a})
    return rows


def batches(tok, rows: list[dict]):
    pad = tok.pad_token_id if tok.pad_token_id is not None else tok.eos_token_id
    for i in range(0, len(rows), MICRO_BATCH):
        chunk = rows[i : i + MICRO_BATCH]
        width = max(len(r["input_ids"]) for r in chunk)
        ids, labels, mask = [], [], []
        for r in chunk:
            n = width - len(r["input_ids"])
            ids.append(r["input_ids"] + [pad] * n)
            labels.append(r["labels"] + [-100] * n)
            mask.append([1] * len(r["input_ids"]) + [0] * n)
        yield {k: torch.tensor(v, device="cuda") for k, v in (("input_ids", ids), ("labels", labels), ("attention_mask", mask))}


def lora_state(model) -> dict[str, torch.Tensor]:
    return {k: v.detach().float().cpu().clone() for k, v in get_peft_model_state_dict(model).items()}


def driver_version() -> str:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
                             capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except (OSError, subprocess.CalledProcessError) as e:
        return f"unknown ({e})"


def run(record: dict) -> None:
    if not torch.cuda.is_available():
        raise RuntimeError("No CUDA GPU visible. The smoke test only runs on the GPU machine.")
    torch.manual_seed(SEED)
    record["environment"] = {
        "gpu": torch.cuda.get_device_name(0),
        "capability": ".".join(map(str, torch.cuda.get_device_capability(0))),
        "gpu_total_mib": mib(torch.cuda.get_device_properties(0).total_memory),
        "driver": driver_version(),
        "platform": platform.platform(),
        "python": platform.python_version(),
        "torch": torch.__version__,
        "torch_cuda": torch.version.cuda,
        "transformers": transformers.__version__,
        "peft": peft.__version__,
    }
    log.info("environment %s", json.dumps(record["environment"]))

    for i, (model_id, revision) in enumerate(MODELS):
        try:
            tok, base = load_base(model_id, revision)
            break
        except Exception as e:  # noqa: BLE001
            log.warning("could not load %s@%s: %r", model_id, revision, e)
            record.setdefault("fallback_reasons", []).append(f"{model_id}: {e!r}")
            if i == len(MODELS) - 1:
                raise
    record["model"] = {"id": model_id, "revision": revision, "class": type(base).__name__,
                       "fallback": i > 0, "dtype": "bfloat16"}
    log.info("model %s", json.dumps(record["model"]))

    cases = smoke_cases()
    rows = encode(tok, cases)
    record["cases"] = {"count": len(cases), "sha256": cases_sha256(cases),
                       "labels": {lab: sum(c["label"] == lab for c in cases) for lab in LABELS},
                       "max_tokens": max(len(r["input_ids"]) for r in rows)}
    log.info("cases %s", json.dumps(record["cases"]))

    model = get_peft_model(base, LoraConfig(task_type="CAUSAL_LM", **LORA))
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    record["lora"] = {**LORA, "trainable_params": trainable, "steps": STEPS, "micro_batch": MICRO_BATCH,
                      "lr": LR, "weight_decay": 0.0}
    log.info("lora %s", json.dumps(record["lora"]))

    before = lora_state(model)
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=LR, weight_decay=0.0)
    n_micro = -(-len(rows) // MICRO_BATCH)
    torch.cuda.reset_peak_memory_stats()
    t0 = time.perf_counter()
    model.train()
    losses = []
    for step in range(STEPS):
        total = 0.0
        for b in batches(tok, rows):
            loss = model(**b).loss / n_micro
            loss.backward()
            total += loss.item()
        frozen_with_grad = [n for n, p in model.named_parameters() if not p.requires_grad and p.grad is not None]
        assert not frozen_with_grad, f"frozen params received gradients: {frozen_with_grad[:3]}"
        opt.step()
        opt.zero_grad(set_to_none=True)
        losses.append(round(total, 4))
        log.info("step %d: forward+backward on %d cases, mean loss %.4f", step + 1, len(rows), total)
    torch.cuda.synchronize()
    record["train"] = {"losses": losses, "seconds": round(time.perf_counter() - t0, 2),
                       "peak_allocated_mib": mib(torch.cuda.max_memory_allocated()),
                       "peak_reserved_mib": mib(torch.cuda.max_memory_reserved())}
    log.info("train %s", json.dumps(record["train"]))

    after = lora_state(model)
    unchanged = [k for k in before if torch.equal(before[k], after[k])]
    max_delta = max((after[k] - before[k]).abs().max().item() for k in before)
    record["checks"] = {"adapter_tensors": len(before), "unchanged_after_training": len(unchanged),
                        "max_abs_delta": max_delta}
    assert not unchanged, f"{len(unchanged)} adapter tensors did not change, e.g. {unchanged[:3]}"
    log.info("check passed: all %d adapter tensors changed (max |delta| %.3e)", len(before), max_delta)

    out = ML / "adapters" / "smoke"
    model.save_pretrained(out)
    files = {p.name: sha256_file(p) for p in sorted(out.iterdir()) if p.is_file()}
    record["adapter"] = {"files": files, "bytes": sum(p.stat().st_size for p in out.iterdir() if p.is_file())}
    log.info("adapter saved to %s: %s", out.relative_to(ML), json.dumps(files))

    model.eval()
    probe = next(batches(tok, rows))
    with torch.no_grad():
        logits_trained = model(input_ids=probe["input_ids"], attention_mask=probe["attention_mask"]).logits
    _, fresh = load_base(model_id, revision)
    reloaded = PeftModel.from_pretrained(fresh, out).eval()
    loaded = lora_state(reloaded)
    mismatched = [k for k in after if k not in loaded or not torch.equal(after[k], loaded[k])]
    assert set(loaded) == set(after), "reloaded adapter has different tensor names"
    assert not mismatched, f"{len(mismatched)} reloaded tensors differ, e.g. {mismatched[:3]}"
    with torch.no_grad():
        logits_reloaded = reloaded(input_ids=probe["input_ids"], attention_mask=probe["attention_mask"]).logits
    logit_diff = (logits_trained.float() - logits_reloaded.float()).abs().max().item()
    assert logit_diff <= 1e-3, f"reloaded logits differ by {logit_diff}"
    record["checks"].update({"reloaded_tensors_equal": len(loaded), "reloaded_max_logit_diff": logit_diff})
    log.info("check passed: reloaded adapter equals the trained one (%d tensors, max logit diff %.2e)",
             len(loaded), logit_diff)

    record["peak_allocated_mib_train_and_reload"] = mib(torch.cuda.max_memory_allocated())
    record["passed"] = True


def main() -> int:
    stamp = datetime.now().astimezone()
    manifests = ML / "manifests"
    manifests.mkdir(exist_ok=True)
    stem = manifests / f"smoke-{stamp:%Y-%m-%d}"
    handlers = [logging.StreamHandler(sys.stdout), logging.FileHandler(f"{stem}.log", mode="w")]
    for h in handlers:
        h.addFilter(lambda r: not r.name.startswith(("httpx", "httpcore")))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=handlers)
    record: dict = {"task": "T4.5", "started": stamp.isoformat(timespec="seconds"), "passed": False,
                    "evidence": "ran on local GPU; synthetic cases, not a quality measurement",
                    "note": "GPU backward kernels are not deterministic, so the adapter hash identifies "
                            "this run's artifact and is not reproducible bit for bit."}
    try:
        run(record)
    except Exception as e:
        record["error"] = repr(e)
        log.exception("smoke test FAILED")
    finally:
        Path(f"{stem}.json").write_text(json.dumps(record, indent=2) + "\n")
    log.info("smoke test %s", "PASSED" if record["passed"] else "FAILED")
    return 0 if record["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
