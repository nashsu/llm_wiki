# FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness

Tri Dao, Daniel Y. Fu, Stefano Ermon, Atri Rudra, Christopher Ré
(Stanford University, University at Buffalo)

## Abstract

Transformers are slow and memory-hungry on long sequences, since the time
and memory complexity of self-attention are quadratic in sequence length.
Approximate attention methods have attempted to address this problem by
trading off model quality to reduce the compute complexity, but often do
not achieve wall-clock speedup. We argue that a missing principle is making
attention algorithms IO-aware — accounting for reads and writes between
levels of GPU memory. We propose FlashAttention, an IO-aware exact
attention algorithm that uses tiling to reduce the number of memory reads
and writes between GPU high bandwidth memory (HBM) and GPU on-chip SRAM.
We analyze the IO complexity of FlashAttention, showing that it requires
fewer HBM accesses than standard attention, and is optimal for a range of
SRAM sizes.

## 1. Introduction

The transformer architecture has become ubiquitous in natural language
processing and is increasingly applied to vision, audio, and scientific
domains. Its core is the self-attention mechanism, which scales
quadratically with sequence length in both time and memory. This quadratic
cost has motivated a large body of work on approximate attention,
including sparse patterns, low-rank approximations, and kernel-based
methods. However, most of these approximations do not deliver wall-clock
speedups: they reduce the number of floating-point operations, but on
modern GPUs, attention is memory-bound, not compute-bound.

We identify the main bottleneck: moving attention matrices between GPU
high-bandwidth memory (HBM) and the much faster but smaller on-chip SRAM.
Standard attention implementations materialize the full N×N attention
matrix in HBM, requiring O(N²) reads and writes. FlashAttention instead
never materializes this matrix; it computes attention in blocks that fit
in SRAM, using tiling and a recomputation trick for the backward pass.

## 2. Background: Memory Hierarchy on GPUs

GPUs have a memory hierarchy: registers, shared memory (per-streaming-
multiprocessor SRAM), and HBM. HBM is large (40-80 GB on A100) but slow
(~1.5 TB/s), while shared memory is tiny (~192 KB per SM on A100) but
extremely fast (~19 TB/s). Kernel runtime is often dominated by HBM
traffic rather than compute. An IO-aware algorithm carefully schedules
computation to minimize HBM reads and writes.

## 3. The FlashAttention Algorithm

The forward pass of FlashAttention works as follows. Queries Q, keys K,
and values V are split into blocks that fit in SRAM. For each block of
queries, we iterate over blocks of keys and values, computing partial
attention scores and maintaining running statistics (max for numerical
stability and sum for normalization). The final output for each query
block is assembled from these block-wise partial results.

The crucial observation: we never need to materialize the full N×N
attention matrix. We only need per-block statistics, which fit in SRAM.

For the backward pass, we cannot afford to store the full attention matrix
either. Instead, FlashAttention uses a recomputation trick: during the
forward pass, we save the statistics (max and sum per row) along with the
output. During the backward pass, we recompute the attention matrix in
blocks on the fly, using the saved statistics to avoid re-deriving them.

## 4. IO Complexity Analysis

Standard attention: Ω(Nd + N²) HBM accesses, where N is sequence length
and d is head dimension. The N² term comes from reading/writing the
attention matrix.

FlashAttention: O(N²d²/M) HBM accesses, where M is SRAM size. For typical
GPU configurations (d ≈ 64, M ≈ 100 KB), this is strictly better than
standard attention whenever N > M/d ≈ 1500. For long sequences (N ≥ 2K),
FlashAttention is orders of magnitude more IO-efficient.

## 5. Empirical Results

FlashAttention yields 2-4× wall-clock speedup over PyTorch attention on
GPT-2 training, with no quality degradation (it is exact, not approximate).
On BERT training, we observe 15% end-to-end speedup. Most strikingly,
FlashAttention enables much longer contexts: models that previously OOM at
N=2K now train with N=16K or more on the same hardware.

FlashAttention has been integrated into PyTorch, DeepSpeed, MegatronLM, and
is now standard in most transformer training pipelines.
