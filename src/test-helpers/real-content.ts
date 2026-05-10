/**
 * Real-content fixtures for real-LLM testing.
 *
 * AUTHORITATIVE source of truth for all source documents fed to the LLM
 * in real-llm tests. Materialized to tests/fixtures/real-content/ (which
 * is gitignored) by `materializeRealContent()` at test startup.
 *
 * Each doc is designed with a specific testing intent — see the comment
 * above each const for what feature path it exercises.
 */
import fs from "node:fs/promises"
import path from "node:path"

// ── A. Existing baseline (4) ────────────────────────────────────────────────

/** RoFormer / RoPE paper — basic English ingest, cross-refs attention/transformer. */
const ROPE_PAPER = `# RoFormer: Enhanced Transformer with Rotary Position Embedding

Jianlin Su, Yu Lu, Shengfeng Pan, Ahmed Murtadha, Bo Wen, Yunfeng Liu
(Zhuiyi Technology Co., Ltd., Shenzhen)

## Abstract

Position encoding recently has shown effective in the transformer architecture.
It enables valuable supervision for dependency modeling between elements at
different positions of the sequence. In this paper, we first investigate various
methods to integrate positional information into the learning process of
transformer-based language models. Then, we propose a novel method named Rotary
Position Embedding (RoPE) to effectively leverage the positional information.
Specifically, the proposed RoPE encodes the absolute position with a rotation
matrix and meanwhile incorporates the explicit relative position dependency in
self-attention formulation. Notably, RoPE enables valuable properties, including
the flexibility of sequence length, decaying inter-token dependency with
increasing relative distances, and the capability of equipping the linear
self-attention with relative position encoding. Finally, we evaluate the
enhanced transformer with rotary position embedding, also called RoFormer, on
various long text classification benchmark datasets. Our experiments show that
it consistently overcomes its alternatives.

## 1. Introduction

The sequential order of words is of great value to natural language understanding.
Recurrent neural networks (RNNs) encode the order of tokens by recursively
computing a hidden state along the time dimension. Convolutional neural networks
(CNNs) were thought to be position-agnostic, but recent work has shown that the
commonly used padding operation can implicitly learn positional information.

Recently, the transformer, which is built on top of the self-attention mechanism,
has become the de facto backbone for many natural language processing (NLP) tasks.
Unlike RNN- and CNN-based models, the self-attention mechanism in vanilla
transformers is parallelizable with position-agnostic computations. As a
consequence, various approaches have been proposed to incorporate positional
information into the learning process.

On one hand, absolute position encoding adds position-dependent signals directly
to the context representations, either through a pre-defined function (such as
the sinusoidal encoding used in the original Transformer) or through learnable
embeddings. On the other hand, relative position encodings typically modify the
attention mechanism to be aware of the relative distance between tokens rather
than absolute positions. Shaw et al. (2018) first introduced relative position
encoding by adding a learnable relative position representation to the keys and
values in the attention computation. Subsequent work, including Transformer-XL
and T5, refined this idea with different parameterizations.

## 2. Motivation for Rotary Position Embedding

Both families have limitations. Absolute methods do not naturally generalize to
sequences longer than those seen during training, and they complicate the
extension to relative information. Existing relative methods modify the attention
matrix directly and cannot trivially be combined with efficient attention
variants (such as linear attention) that factorize the attention computation.

We ask: is there a way to encode position that (a) yields relative position
information through standard dot-product attention, (b) extends to arbitrary
sequence length, and (c) is compatible with linear-time attention variants? Our
answer is Rotary Position Embedding.

## 3. Formulation

Given a query vector q at position m and a key vector k at position n, define a
rotation matrix R_Θ,m that rotates q by an angle proportional to m. Applying
R_Θ,m to q and R_Θ,n to k yields the property that the inner product between the
rotated q and the rotated k depends only on the original vectors and the
difference m − n. In other words, absolute position is injected into each
vector, but the attention score between two tokens captures only their relative
position — exactly the behavior we want.

The rotation is applied pairwise across feature dimensions: each consecutive pair
of dimensions is treated as a 2D subspace that is rotated by a frequency-scaled
angle. This extends naturally to arbitrary model dimension d, and is efficient
to compute: no modification to the attention matrix is required, and the same
rotation can be applied in linear attention.

## 4. Properties

- **Long-range decay.** As the relative distance m − n grows, the inner-product
  magnitude decays smoothly, giving the model a useful inductive bias.
- **Sequence-length flexibility.** Because the rotation is a pure function of
  position, no maximum-length hyperparameter needs to be chosen in advance.
- **Linear-attention compatible.** Unlike relative-position methods that add
  terms to the attention matrix, RoPE modifies only the query/key vectors and
  can be used with kernel-based linear attention.

## 5. Empirical Results

We replace the sinusoidal absolute position embedding in a standard transformer
with RoPE, producing what we call RoFormer. On long-text classification tasks
including CAIL2019-SCM and a range of GLUE-style benchmarks, RoFormer outperforms
the vanilla transformer, particularly as input length grows. The gap widens at
inference lengths beyond those seen during training, confirming the
length-flexibility argument.
`

/** FlashAttention paper — GPU memory / IO awareness; stresses entity extraction. */
const FLASH_ATTENTION_PAPER = `# FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness

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
`

/** LoRA paper — math notation + PEFT concepts. */
const LORA_PAPER = `# LoRA: Low-Rank Adaptation of Large Language Models

Edward J. Hu, Yelong Shen, Phillip Wallis, Zeyuan Allen-Zhu, Yuanzhi Li,
Shean Wang, Lu Wang, Weizhu Chen (Microsoft Corporation)

## Abstract

An important paradigm of natural language processing consists of
large-scale pre-training on general domain data and adaptation to
particular tasks or domains. As we pre-train larger models, full
fine-tuning, which retrains all model parameters, becomes less feasible.
Using GPT-3 175B as an example — deploying independent instances of
fine-tuned models, each with 175B parameters, is prohibitively expensive.
We propose Low-Rank Adaptation, or LoRA, which freezes the pre-trained
model weights and injects trainable rank decomposition matrices into each
layer of the Transformer architecture, greatly reducing the number of
trainable parameters for downstream tasks. Compared to GPT-3 175B
fine-tuned with Adam, LoRA can reduce the number of trainable parameters
by 10,000 times and the GPU memory requirement by 3 times.

## 1. Introduction

Large pre-trained language models like GPT-3 contain hundreds of billions
of parameters. Full fine-tuning adapts every parameter to a downstream
task, producing a new copy of the model. At deployment, each fine-tuned
task requires storing and serving a full-size model, which is infeasible
at scale — a single 175B model occupies ~350 GB in fp16 and requires
multiple high-end GPUs to serve.

Parameter-efficient fine-tuning (PEFT) methods aim to adapt large models
to new tasks by training only a small number of extra parameters, leaving
the base model frozen and shared across tasks. Prior PEFT methods include
adapter layers (small MLPs inserted into each transformer block) and
prefix tuning (learnable prefix tokens). Both introduce inference latency
or have difficulty scaling to large models.

## 2. LoRA Formulation

Let W₀ ∈ ℝ^(d×k) be a weight matrix in the pre-trained transformer. During
fine-tuning, instead of updating W₀ to W₀ + ΔW, LoRA represents the update
as a low-rank decomposition:

    ΔW = BA

where B ∈ ℝ^(d×r), A ∈ ℝ^(r×k), and r is a small rank (typically 4, 8, or
16). The forward pass becomes:

    h = W₀x + BAx

At initialization, A is drawn from a random Gaussian and B is zero, so
ΔW = BA = 0. This ensures LoRA starts as a no-op identical to the
pre-trained model. During training, only A and B are updated; W₀ stays
frozen.

The number of trainable parameters is reduced from d×k (full fine-tune)
to r(d + k) (LoRA). For d = k = 4096 and r = 8, this is a ~500×
reduction.

## 3. Applying LoRA to Transformers

LoRA can in principle be applied to any dense layer. In practice, we
apply it only to the attention weights (Wq, Wk, Wv, Wo) and leave the
MLP, LayerNorm, and embeddings frozen. This choice is empirically
motivated: adapting attention is sufficient for most downstream tasks,
and omitting MLP saves substantial parameters.

At inference time, the LoRA update can be merged into the base weights:
    W = W₀ + BA
producing a single matrix with no additional inference cost. This is a
key advantage over adapter methods, which always add inference latency.

## 4. Experimental Results

We evaluate LoRA against full fine-tuning, adapter tuning, and prefix
tuning on GPT-3 175B across GLUE, WikiSQL, SAMSum, and others. Headline
findings:

- **Parameter reduction**: LoRA with r=8 uses 0.01% of full fine-tuning
  parameters (37.7M vs 175B).
- **Performance parity**: On most tasks LoRA matches or exceeds full
  fine-tuning quality.
- **Lower GPU memory**: 3× reduction during training (no optimizer state
  for the base model).
- **No inference overhead**: Merged LoRA is indistinguishable from a
  normally fine-tuned model at inference.

## 5. Rank Analysis

A natural question: how small can r be? Empirically, r=1 or r=2 already
captures most of the adaptation for many tasks. This suggests that
task-specific adaptation lives in a very low-dimensional subspace of the
full parameter space — a striking structural fact about large pre-trained
models.

## 6. Impact

LoRA has become the standard way to fine-tune large language models. It
powers popular tools like PEFT (HuggingFace), has spawned extensions like
QLoRA (4-bit quantized base + LoRA), and enables the thriving ecosystem
of fine-tuned open-weights models on consumer GPUs.
`

/** Chinese Transformer survey — Chinese → Chinese wiki output. */
const TRANSFORMER_SURVEY_ZH = `# Transformer 架构综述

## 摘要

Transformer 架构自 2017 年由 Vaswani 等人在论文《Attention Is All You Need》
中提出以来,已成为自然语言处理和众多其他领域的主导模型架构。本文系统梳理了
Transformer 的核心组件、关键变体以及其在过去数年间的演进脉络,重点关注注意力
机制的不同实现、位置编码方案、模型规模的 Scaling Law 以及针对效率和长序列
建模的多种优化方法。

## 1. 引言

在 Transformer 出现之前,循环神经网络(RNN)和长短期记忆网络(LSTM)是序列
建模的主流方案。它们按时间步依次处理输入,难以并行化,而且对于长距离依赖
的建模存在梯度消失等问题。卷积神经网络(CNN)虽然可以并行,但单层的感受野
有限,需要堆叠多层才能捕获长距离关系。

Transformer 抛弃了循环与卷积,完全基于自注意力机制来建模输入序列各位置之间
的依赖。它天然支持并行计算,同时每一层都能直接建模任意两个位置之间的关系,
突破了 RNN 在长距离依赖上的局限。

## 2. 核心组件

### 2.1 自注意力机制

自注意力的核心是对每个位置 i,计算它与所有位置 j 的相关性(attention score),
并据此对各位置的值向量做加权求和。具体而言,给定查询矩阵 Q、键矩阵 K、值
矩阵 V,注意力输出为:

    Attention(Q, K, V) = softmax(QK^T / √d_k) · V

其中 d_k 是键向量的维度,除以 √d_k 是为了防止点积值过大导致 softmax 梯度消失
(即缩放点积注意力,scaled dot-product attention)。

### 2.2 多头注意力

多头注意力(Multi-Head Attention)将查询、键、值分别投影到多个子空间,每个
子空间独立做注意力计算,最后拼接再投影回原维度。这让模型能够同时关注不同
类型的关系(例如语法、语义、共指)。

### 2.3 位置编码

由于注意力机制本身不具备顺序感,需要显式地向输入中注入位置信息。最早的方案
是正弦/余弦位置编码。后来出现了可学习的绝对位置嵌入、相对位置编码
(Shaw et al., 2018)、以及 RoPE(Rotary Position Embedding,Su et al., 2021)
等更先进的方案。RoPE 通过旋转矩阵将绝对位置信息注入查询和键向量,使得注意力
分数仅依赖于相对位置,目前已成为许多大模型的标配。

## 3. 关键变体

### 3.1 Encoder-only:BERT 系

BERT 及其衍生模型(RoBERTa, ALBERT, ELECTRA)使用双向 Transformer encoder,
通过 masked language modeling 任务进行预训练,擅长理解类任务。

### 3.2 Decoder-only:GPT 系

GPT 系列使用单向(causal)Transformer decoder,通过自回归语言建模进行预训练。
GPT-3/4、LLaMA、Qwen、DeepSeek 等当代主流大语言模型都基于 decoder-only 架构。

### 3.3 Encoder-Decoder:T5、BART

保留原始 Transformer 的完整 encoder-decoder 结构,适用于翻译、摘要等序列到
序列任务。

## 4. 效率优化

### 4.1 注意力近似

标准自注意力的时间和空间复杂度均为 O(N²),对长序列不友好。近似方法包括:
Sparse Attention(Longformer、BigBird)、低秩近似(Performer、Linformer)、
线性注意力等。这些方法以轻微质量损失换取显著速度提升。

### 4.2 IO 感知优化

FlashAttention(Dao et al., 2022)不近似注意力矩阵,而是通过分块计算避免
将完整的 N×N 矩阵写入 HBM。它是精确注意力,但在 GPU 上的实际 wall-clock
速度比 PyTorch 原生实现快 2-4 倍,已成为训练与推理的事实标准。

### 4.3 参数高效微调

在模型规模突破千亿参数后,全量微调(full fine-tuning)成本过高。LoRA(Hu et al.,
2021)通过在注意力权重旁增加低秩矩阵,仅训练极少量参数即可达到与全量微调
相当的效果,极大降低了微调成本。

## 5. Scaling Law

Kaplan et al. (2020) 和 Hoffmann et al. (Chinchilla, 2022) 的研究表明,
Transformer 的性能遵循明确的 scaling law:随模型参数量 N、训练数据量 D、计算
量 C 的幂律提升。这启发了 GPT-4、LLaMA-3、Qwen3 等更大规模模型的训练策略,
也为"更大即更好"提供了理论依据。

## 6. 未来方向

目前的研究热点包括:超长上下文(1M+ token)、多模态融合、专家混合
(Mixture of Experts, MoE)架构、以及推理链式思维(Chain-of-Thought)等。
Transformer 作为基础架构仍在持续演进。
`

// ── C. Review-triggering docs (3) ──────────────────────────────────────────

/**
 * Vision Transformer — deliberately mentions concepts NOT in seed wiki
 * (layer normalization, GELU activation, class token, patch embedding).
 * Expected: LLM emits multiple `missing-page` review blocks.
 */
const MISSING_PAGE_TRIGGER = `# Vision Transformer: An Image is Worth 16×16 Words

Alexey Dosovitskiy et al. (Google Research)

## Abstract

Transformer architectures, originally dominant in NLP, can be applied to
images almost verbatim when the image is first split into fixed-size patches.
Vision Transformer (ViT) treats a 224×224 image as a sequence of 196 patches
of 16×16 pixels, linearly projects each patch into a d-dimensional embedding,
and feeds the resulting sequence through a standard transformer encoder.

## Architecture

Four components that depart from vanilla transformers:

### Patch Embedding

Each 16×16×3 image patch is flattened and projected via a learnable linear
layer into a d-dim embedding. For a 224×224 RGB image this yields 196
embeddings of dimension d (typically 768 for ViT-Base).

### Class Token

A learnable [CLS] token embedding is prepended to the patch sequence. Its
final-layer representation serves as the classification feature. This is
borrowed from BERT.

### Positional Encoding

Because the transformer is permutation-invariant, ViT adds learnable
position embeddings to each patch. Unlike sinusoidal encoding, these are
trained from scratch and tied to specific spatial locations.

### Layer Normalization and GELU Activation

ViT uses Pre-Layer Normalization — normalizing the inputs to each sublayer
rather than the outputs (as the original transformer does). The activation
in the MLP is GELU (Gaussian Error Linear Unit), not ReLU.

## Training

ViT requires large-scale pre-training to outperform CNNs. When trained
only on ImageNet-1k it underperforms ResNets; however, pre-trained on
JFT-300M (a 300-million-image Google-internal dataset) and then fine-tuned,
it surpasses the state-of-the-art with significantly less compute per
example.

## Inductive Bias

Unlike CNNs which bake in locality and translation equivariance, ViT has
much less image-specific inductive bias. Positional embeddings are learned
and no 2D-neighborhood structure is hardcoded. This makes ViT data-hungry
but also more flexible — it generalizes well when enough data is available.

## Impact

ViT opened the door to applying NLP architectures in computer vision.
Follow-up work (Swin Transformer, DeiT, MAE) refines data efficiency,
hierarchical processing, and self-supervised pre-training. It also
motivated unified multimodal models like CLIP and Flamingo that share
a transformer backbone across modalities.

## Limitations

- Computational cost is quadratic in the number of patches, making
  high-resolution images expensive.
- Without large-scale pre-training, ViT is weaker than a good CNN.
- The learnable position embeddings don't naturally generalize to image
  sizes different from training.
`

/**
 * Attention Deep Dive — paraphrases the content of seed wiki attention.md.
 * Expected: LLM emits a `duplicate` review block flagging overlap.
 */
const DUPLICATE_TRIGGER = `# Attention Mechanism: A Deep Dive

This article provides a thorough walkthrough of the attention mechanism
that underpins modern transformer architectures.

## What is Attention?

Attention is a mechanism that assigns per-token weights within a sequence.
Given queries, keys, and values, it computes a weighted sum of values
where weights come from a similarity function between queries and keys.
This lets each output position attend to any input position — a global
rather than local receptive field.

## Query, Key, Value Explained

Every token produces three learned projections:
- The **query** (q) represents what the token is looking for.
- The **key** (k) represents what the token offers.
- The **value** (v) represents the content to be aggregated.

The attention score between token i's query and token j's key determines
how much of token j's value is mixed into token i's output.

## Scaled Dot-Product Attention

The canonical formulation is:

    Attention(Q, K, V) = softmax(Q Kᵀ / √d_k) V

The scaling by √d_k is crucial — without it, large dot products push
softmax into saturation, producing vanishing gradients.

## Why Attention Beat Recurrence

Recurrent networks process tokens sequentially, making parallelization
impossible and accumulating gradients through many steps. Attention
computes all pairwise relationships in a single matrix multiply —
parallel, shallow, and surprisingly effective.

## Attention in Transformers

Transformer layers alternate attention with feedforward networks.
Multi-head attention runs several attention operations in parallel,
each with its own Q/K/V projection, giving the model the ability to
attend to different kinds of relationships simultaneously.

## Complexity

Attention is O(N²) in both time and memory. Approximate variants
(sparse, low-rank, kernel) trade quality for efficiency; exact variants
(FlashAttention) reduce wall-clock cost through IO-aware algorithms.

## Conclusion

Attention replaces recurrence and convolution with a single primitive:
a content-based weighted average. Its simplicity plus parallelism made
the transformer possible and now dominates most of modern ML.
`

/**
 * Linear Attention with Gaussian Kernels — explicitly claims attention
 * uses Gaussian kernels rather than softmax. Contradicts seed wiki
 * attention.md which says softmax.
 * Expected: LLM emits a `contradiction` review.
 */
const CONTRADICTION_TRIGGER = `# Revisiting Attention: A Gaussian-Kernel Perspective

Recent theoretical work reframes the attention mechanism not as a
softmax-weighted dot product but as a Gaussian-kernel similarity between
query and key vectors. This piece argues that the canonical softmax
formulation is a convenient approximation, and that the underlying
mechanism is inherently Gaussian.

## The Claim

The attention score between query q at position m and key k at position n
in modern transformers is computed as:

    A(m, n) = exp(-‖q_m − k_n‖² / (2σ²))

This Gaussian kernel over the Euclidean distance replaces the softmax
over dot products found in early transformer descriptions. The Gaussian
form is exact; softmax is simply a historical accident of how the
mechanism was first described in 2017.

## Why Gaussian, Not Softmax

1. Gaussian kernels are translation-invariant in feature space, giving
   attention a natural geometric interpretation that softmax lacks.
2. The Gaussian formulation extends more cleanly to continuous-input
   domains (audio, video).
3. Empirically, replacing softmax with Gaussian kernels in an ablation
   shows no degradation — and in fact produces smoother gradients during
   training, confirming that softmax has no essential advantage.

## Implementation

Every modern attention layer is implicitly computing a Gaussian kernel,
with σ corresponding to the inverse temperature of the apparent softmax.
This insight simplifies understanding of why normalization by √d_k is
needed: it calibrates the distance scale so the Gaussian has appropriate
bandwidth.

## Consequences

Attention architectures should be understood as kernel methods in
disguise. The "softmax attention" label in papers and textbooks is
misleading and should be replaced by the Gaussian description.

## Related Claim

A corollary of this perspective: attention does NOT assign per-token
weights in the way often described. Instead, it computes a smoothed
density over key positions. The weighted-sum-of-values interpretation
is a convenient computational shortcut, not a faithful description of
what the mechanism computes.
`

// ── D. Knowledge graph / entity docs (2) ─────────────────────────────────────

/**
 * Geoffrey Hinton biography — packed with named entities (people,
 * institutions, papers). Expected: many wiki/entities/*.md pages.
 */
const BIOGRAPHICAL_HINTON = `# Geoffrey Hinton: A Biography

Geoffrey Hinton, born in Wimbledon, England in 1947, is a British-Canadian
cognitive psychologist and computer scientist whose work laid the
foundation of modern deep learning. He was awarded the 2018 Turing Award
(shared with Yann LeCun and Yoshua Bengio) for conceptual and engineering
breakthroughs that have made deep neural networks a critical component
of computing.

## Early Career

Hinton studied experimental psychology at Cambridge and received his PhD
from the University of Edinburgh in 1978, supervised by Christopher
Longuet-Higgins. His early research on distributed representations and
the Boltzmann machine, developed jointly with Terry Sejnowski at Johns
Hopkins and Carnegie Mellon, established core ideas that would later
underpin deep learning.

## Backpropagation

In 1986, Hinton co-authored with David Rumelhart and Ronald Williams the
paper "Learning representations by back-propagating errors", which
popularized the backpropagation algorithm for training multi-layer neural
networks. Although the algorithm had been independently discovered
earlier (by Seppo Linnainmaa, Paul Werbos, and others), it was this paper
that brought it into the mainstream.

## University of Toronto and the Deep Learning Revival

Hinton moved to the University of Toronto in 1987 and founded the Vector
Institute in 2017. His Toronto group, including students Ilya Sutskever,
Alex Krizhevsky, and Ruslan Salakhutdinov, produced key breakthroughs:

- **2006 deep belief networks**, which showed that layer-wise pre-training
  could train deep networks long before GPUs made end-to-end training
  feasible.
- **2012 AlexNet**, authored by Alex Krizhevsky with Sutskever and Hinton,
  which won the ImageNet Large Scale Visual Recognition Challenge by a
  decisive margin and triggered the deep learning explosion.
- **2014 word embeddings and sequence models**, foundational for the NLP
  revolution.

## Google and Later Work

Hinton joined Google in 2013 after Google acquired DNNresearch, the
company he had founded with Krizhevsky and Sutskever. At Google Brain he
worked on capsule networks, distillation, and large-scale image models.
In 2023 he resigned from Google to speak openly about risks from advanced
AI, and has since become a prominent voice in AI safety discussions.

## Honors and Legacy

- 2018 Turing Award, shared with Yann LeCun (NYU / Meta) and Yoshua
  Bengio (Université de Montréal / MILA).
- Foreign Member of the US National Academy of Engineering.
- Officer of the Order of Canada.

His students — Ilya Sutskever (co-founder of OpenAI), Alex Krizhevsky
(now at Dessa), Ruslan Salakhutdinov (Apple AI), Tijmen Tieleman
(Xpert.ai), and many others — have gone on to lead significant AI
research efforts worldwide.

## Academic Descendants

Hinton's intellectual influence extends through a family tree of
researchers: his PhD students and postdocs include Radford Neal, Peter
Dayan, Zoubin Ghahramani, Brendan Frey, Max Welling, and Andriy Mnih,
each leading their own influential labs.
`

/**
 * Rich survey — explicitly references many existing + possible wiki
 * concepts. Expected: dense [[wikilinks]] output (knowledge graph stress).
 */
const RICH_GRAPH_SURVEY = `# Modern Deep Learning: An Interconnected Survey

The field of modern deep learning cannot be understood as isolated
techniques; it is a network of ideas that build on and cross-reference
each other. This survey walks through the major nodes of that network
and the edges between them.

## Foundations

The story begins with the **transformer** architecture, built on the
**attention** mechanism. Attention in turn relies on **scaled dot-product**
similarity computation. Position information is injected via
**positional encoding**, with modern systems favoring **RoPE** (Rotary
Position Embedding) over sinusoidal variants.

## Scaling

Transformers scale predictably per the **scaling law** established by
Kaplan and refined by Chinchilla. Scaling to 175B+ parameters (GPT-3,
LLaMA, Qwen) required engineering advances: **FlashAttention** for
memory-efficient attention, **mixture of experts** (MoE) for sparse
compute, and **tensor parallelism** for distributed training.

## Adaptation

At trillion-parameter scale, full fine-tuning is infeasible, so
**parameter-efficient fine-tuning** techniques emerged. **LoRA** (Low-Rank
Adaptation) injects low-rank update matrices into attention layers; its
4-bit quantized variant **QLoRA** runs on consumer GPUs. **Prefix tuning**
and **adapter** layers are alternatives.

## Alignment

Aligning large models with human preferences uses **RLHF** (Reinforcement
Learning from Human Feedback) — first **supervised fine-tuning**, then
**reward modeling**, then **PPO**-based policy optimization. Recent
variants include **DPO** (Direct Preference Optimization) which skips
the separate reward model.

## Retrieval

**RAG** (Retrieval-Augmented Generation) grounds model outputs in
retrieved documents. Typical pipelines use **dense embeddings** (e.g.,
**BGE**, **E5**) for initial recall, rerank with a cross-encoder, and
feed top results into the transformer. Vector databases like **FAISS**
and **LanceDB** power retrieval at scale.

## Inference

At inference time, **KV cache** reuse is critical for long-context
generation. **Flash Decoding** and **PagedAttention** (vLLM) optimize
memory layouts. **Speculative decoding** runs a small draft model
alongside the main model to reduce latency.

## Multimodal

**CLIP** aligned image and text embeddings; **ViT** (Vision Transformer)
applied transformer blocks to image patches. **LLaVA**, **Flamingo**, and
**GPT-4V** combine vision encoders with language models for vision-language
tasks. Audio counterparts include **Whisper** (speech-to-text) and **Bark**.

## Reasoning

**Chain-of-Thought** prompting elicits step-by-step reasoning.
**ReAct** interleaves reasoning with tool use. Recent "reasoning models"
(o1, o3, DeepSeek-R1) are trained to internally produce extended
chain-of-thought before answering.

## Evaluation

Benchmarks include **GLUE** and **SuperGLUE** (NLU), **MMLU** (broad
knowledge), **HumanEval** and **MBPP** (code), **GSM8K** and **MATH**
(math reasoning). Leaderboards fade quickly as models saturate.

## Ecosystem

Open weights: **LLaMA** (Meta), **Qwen** (Alibaba), **Mistral**,
**DeepSeek**, **Gemma** (Google). Proprietary: **GPT-4** (OpenAI),
**Claude** (Anthropic), **Gemini** (Google). Infrastructure: **PyTorch**,
**JAX**, **Triton** kernels, **DeepSpeed**, **MegatronLM**.

Every node in this graph relates to multiple others. The health of the
field depends on these cross-references staying current and precise.
`

// ── E. Domain diversity (3) ──────────────────────────────────────────────────

/** SaaS Terms of Service — non-academic legal prose. */
const LEGAL_SAAS_TOS = `# Example SaaS Inc. — Terms of Service

Effective Date: January 1, 2026

These Terms of Service ("Terms") govern your access to and use of the
services ("Services") provided by Example SaaS Inc. ("Company", "we",
"us", or "our"). By accessing or using the Services, you agree to be
bound by these Terms.

## 1. Account Registration

1.1. You must be at least 18 years of age to register an account. By
registering, you represent and warrant that you meet this requirement.

1.2. You agree to provide accurate, current, and complete information
during registration and to update such information to keep it accurate.

1.3. You are responsible for maintaining the confidentiality of your
account credentials. You agree to notify us immediately of any
unauthorized access to your account.

## 2. Acceptable Use

2.1. You shall not use the Services for any unlawful purpose or in a
manner that violates applicable laws or regulations.

2.2. You shall not attempt to gain unauthorized access to any portion
of the Services or any related systems or networks.

2.3. You shall not upload, transmit, or distribute any content that
infringes third-party intellectual property rights, contains malicious
code, or is otherwise harmful.

2.4. You shall not interfere with or disrupt the integrity or
performance of the Services, including but not limited to: conducting
denial-of-service attacks, automated scraping beyond documented rate
limits, or probing for security vulnerabilities without prior written
consent.

## 3. Subscription and Payment

3.1. Access to certain features requires a paid subscription.
Subscription fees are billed monthly or annually in advance and are
non-refundable except as required by applicable law.

3.2. All fees are exclusive of taxes. You are responsible for any
applicable taxes, levies, or duties arising from your use of the
Services.

3.3. We reserve the right to modify pricing upon thirty (30) days'
written notice. Continued use of the Services after the effective date
of such change constitutes acceptance.

## 4. Data Privacy

4.1. Our Privacy Policy, incorporated herein by reference, describes
how we collect, use, and disclose information about you.

4.2. You retain all rights, title, and interest in content you submit
to the Services ("Customer Data"). You grant us a limited license to
host, reproduce, and display Customer Data solely to provide the
Services to you.

## 5. Intellectual Property

5.1. The Services, including all software, design, text, graphics,
and other content, are owned by us or our licensors and protected by
copyright, trademark, and other laws.

5.2. Except as expressly granted herein, no rights or licenses are
granted to you with respect to the Services.

## 6. Termination

6.1. Either party may terminate these Terms for convenience upon thirty
(30) days' written notice.

6.2. We may suspend or terminate your access immediately if you breach
these Terms. Sections 4 (Data Privacy), 5 (Intellectual Property), 7
(Warranty Disclaimer), and 8 (Limitation of Liability) survive
termination.

## 7. Warranty Disclaimer

THE SERVICES ARE PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES
OF ANY KIND, WHETHER EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION
THE IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE, AND NON-INFRINGEMENT.

## 8. Limitation of Liability

IN NO EVENT SHALL COMPANY BE LIABLE FOR ANY INDIRECT, INCIDENTAL,
SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES ARISING OUT OF OR RELATING
TO THESE TERMS OR THE SERVICES, EVEN IF ADVISED OF THE POSSIBILITY OF
SUCH DAMAGES. OUR TOTAL LIABILITY SHALL NOT EXCEED THE FEES PAID BY YOU
IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM.

## 9. Governing Law

These Terms are governed by the laws of the State of Delaware, without
regard to its conflict-of-laws rules.
`

/** Thai green curry recipe — step-based instructional content. */
const RECIPE_THAI_CURRY = `# Thai Green Curry (Gaeng Keow Wan Gai)

A creamy, aromatic curry that balances sweet, salty, and spicy notes.
This recipe yields 4 servings and takes about 40 minutes total.

## Ingredients

### Curry Paste (or use 4 tbsp store-bought green curry paste)
- 10 green Thai chilies, stems removed
- 3 stalks lemongrass, white parts only, thinly sliced
- 4 cloves garlic
- 1 shallot, roughly chopped
- 2 tsp galangal, peeled and sliced
- 1 tsp kaffir lime zest (or 3 kaffir lime leaves)
- 1 tsp coriander seeds, toasted
- 1 tsp cumin seeds, toasted
- 1 tsp white peppercorns
- 1 tsp shrimp paste
- 1 tsp salt

### Curry
- 2 tbsp coconut oil
- 1 can (400 ml) full-fat coconut milk, cream separated from liquid
- 500 g boneless chicken thighs, sliced into bite-sized pieces
- 2 cups (200 g) Thai eggplant, quartered (or use Chinese eggplant cubes)
- 1/2 cup (60 g) bamboo shoots, drained
- 100 g Thai basil leaves (do not substitute with Italian basil)
- 2 tbsp fish sauce
- 1 tbsp palm sugar (or brown sugar)
- 3 kaffir lime leaves, torn
- 2 long red chilies, sliced (for garnish)

## Equipment
- Mortar and pestle (or food processor)
- Large wok or deep skillet
- Wooden spoon or spatula

## Method

### 1. Prepare the Paste

If making paste from scratch, pound all paste ingredients together in a
mortar and pestle until a smooth, fragrant paste forms. This takes about
15 minutes of steady pounding. Alternatively, pulse in a food processor
with 2 tbsp water.

### 2. Fry the Paste

Heat coconut oil in the wok over medium heat. Spoon the thick coconut
cream (the top layer from the can) into the wok and stir-fry for about
3 minutes until the oil separates and shimmers on the surface.

Add 4 tablespoons of curry paste. Fry, stirring constantly, for 2-3
minutes until deeply aromatic.

### 3. Add Chicken

Add the chicken pieces to the wok. Stir-fry for 4-5 minutes until the
outside turns opaque.

### 4. Simmer

Pour in the remaining coconut milk. Add fish sauce, palm sugar, and
kaffir lime leaves. Bring to a gentle simmer.

### 5. Add Vegetables

Add the Thai eggplant and bamboo shoots. Simmer uncovered for 10 minutes,
or until eggplant is tender but still holds its shape.

### 6. Finish

Stir in Thai basil leaves and remove from heat immediately — residual
heat will wilt the basil. Taste and adjust with more fish sauce (salty)
or palm sugar (sweet) as desired.

### 7. Serve

Serve hot over jasmine rice, garnished with sliced red chilies and
additional basil leaves.

## Tips

- **Coconut cream matters**: Avoid light coconut milk — you need the
  fat content for the paste to bloom correctly.
- **Thai basil only**: Italian basil won't deliver the anise note that
  defines this dish.
- **Don't boil too hard**: Aggressive boiling breaks the coconut milk.
  Keep it at a gentle simmer.
`

/**
 * Math-heavy: Maxwell's equations + physics. LaTeX density test —
 * Greek letters, nabla operators, partial derivatives.
 */
const MATH_HEAVY_MAXWELL = `# Maxwell's Equations: A Mathematical Tour

Maxwell's equations are four coupled partial differential equations that
describe how electric and magnetic fields are generated and interact.
They form the foundation of classical electromagnetism, optics, and
electric circuits.

## The Four Equations (Differential Form)

### Gauss's Law for Electricity

$$ \\nabla \\cdot \\vec{E} = \\frac{\\rho}{\\varepsilon_0} $$

The divergence of the electric field $\\vec{E}$ at a point equals the
charge density $\\rho$ divided by the permittivity of free space
$\\varepsilon_0$. Physically: electric charges produce outward-pointing
field lines; the total flux through any closed surface is proportional
to the enclosed charge.

### Gauss's Law for Magnetism

$$ \\nabla \\cdot \\vec{B} = 0 $$

The divergence of the magnetic field $\\vec{B}$ is zero everywhere. This
is the formal statement that magnetic monopoles do not exist — magnetic
field lines always form closed loops.

### Faraday's Law of Induction

$$ \\nabla \\times \\vec{E} = -\\frac{\\partial \\vec{B}}{\\partial t} $$

A time-varying magnetic field induces a curl in the electric field. The
minus sign encodes Lenz's law: the induced electric field opposes the
change that produces it. This principle underlies electric generators,
transformers, and inductors.

### Ampère-Maxwell Law

$$ \\nabla \\times \\vec{B} = \\mu_0 \\vec{J} + \\mu_0 \\varepsilon_0
\\frac{\\partial \\vec{E}}{\\partial t} $$

Magnetic fields are produced both by current density $\\vec{J}$ (Ampère's
original form) and by a time-varying electric field (Maxwell's
displacement current correction). $\\mu_0$ is the permeability of free
space.

## Deriving the Wave Equation

Taking the curl of Faraday's Law and substituting the Ampère-Maxwell Law
into it (in free space, where $\\rho = 0$ and $\\vec{J} = 0$):

$$ \\nabla^2 \\vec{E} = \\mu_0 \\varepsilon_0
\\frac{\\partial^2 \\vec{E}}{\\partial t^2} $$

This is the wave equation with propagation speed

$$ c = \\frac{1}{\\sqrt{\\mu_0 \\varepsilon_0}} $$

In SI units $\\mu_0 = 4\\pi \\times 10^{-7}$ H/m and $\\varepsilon_0
\\approx 8.854 \\times 10^{-12}$ F/m, yielding $c \\approx 3 \\times
10^8$ m/s — the speed of light. Maxwell recognized in 1865 that light
itself is an electromagnetic wave.

## Integral Forms

Each differential equation has an equivalent integral form, obtained by
applying the divergence theorem or Stokes' theorem:

- $\\oint_S \\vec{E} \\cdot d\\vec{A} = Q_{\\text{enc}} / \\varepsilon_0$
- $\\oint_S \\vec{B} \\cdot d\\vec{A} = 0$
- $\\oint_C \\vec{E} \\cdot d\\vec{l} = -\\frac{d\\Phi_B}{dt}$
- $\\oint_C \\vec{B} \\cdot d\\vec{l} = \\mu_0 I_{\\text{enc}} +
  \\mu_0 \\varepsilon_0 \\frac{d\\Phi_E}{dt}$

## Constitutive Relations

In materials, the free-space equations are modified by permittivity
$\\varepsilon$ and permeability $\\mu$:

$$ \\vec{D} = \\varepsilon \\vec{E}, \\quad \\vec{B} = \\mu \\vec{H} $$

Linear isotropic materials treat $\\varepsilon$ and $\\mu$ as scalars;
anisotropic crystals require tensors.

## Consequences

- Electromagnetic waves propagate at speed $c$ in vacuum.
- The ratio $E/B$ in a plane wave equals $c$.
- Energy density: $u = \\frac{\\varepsilon_0}{2} E^2 +
  \\frac{1}{2\\mu_0} B^2$.
- Poynting vector $\\vec{S} = \\frac{1}{\\mu_0} \\vec{E} \\times \\vec{B}$
  gives energy flux per unit area.
`

// Continued below — this file grows to include non-English docs, the long
// survey, and the sweep-chain resolver. See next section.

// ── Exports and materialize (stub — will be expanded with remaining docs) ──

export interface RealContentDoc {
  filename: string
  content: string
}

// Intermediate exports — fuller array appears after all docs are declared.
void ROPE_PAPER
void FLASH_ATTENTION_PAPER
void LORA_PAPER
void TRANSFORMER_SURVEY_ZH
void MISSING_PAGE_TRIGGER
void DUPLICATE_TRIGGER
void CONTRADICTION_TRIGGER
void BIOGRAPHICAL_HINTON
void RICH_GRAPH_SURVEY
void LEGAL_SAAS_TOS
void RECIPE_THAI_CURRY
void MATH_HEAVY_MAXWELL

// ── B. Non-English language docs (5) ────────────────────────────────────────

/** Japanese aesthetic philosophy — mono no aware, wabi-sabi, yugen. */
const JAPANESE_PHILOSOPHY = `# 日本美学における三つの概念:もののあわれ、侘び寂び、幽玄

日本の美意識は、西洋の美の理念とは大きく異なる独自の伝統を発展させてきた。
この小論では、平安時代以来の三つの中核的な概念──「もののあわれ」「侘び寂び」
「幽玄」──を紹介し、それらが現代の日本文化においてどのように受け継がれて
いるかを考察する。

## もののあわれ

「もののあわれ」は、事物に触れたときに感じる深い情感を意味する。江戸時代の
国学者、本居宣長が『源氏物語玉の小櫛』において体系化した概念である。桜の花
が散りゆく刹那に人が感じる切なさ、秋の夕暮れに漂う寂しさ、恋人との別れに
込み上げる哀しみ──これらは全て「もののあわれ」の発露である。

宣長は、この情感こそが日本文学の本質であり、『源氏物語』の読者が登場人物に
共感する根源であると論じた。もののあわれは単なる感傷ではなく、無常な世界
に対する倫理的な応答である。物事のはかなさを受け入れ、その一瞬の美しさを
深く味わうことで、人間は世界との調和を得る。

## 侘び寂び

「侘び寂び」は、不完全さ、無常、未完成に見出される美である。室町時代の茶道
において千利休が理論化し、日本文化全体に浸透した。侘びは簡素で質素な様式、
寂びは時を経た物が帯びる枯淡な風情を指す。

例えば、ひび割れた茶碗を金で継ぐ「金継ぎ」は、破損を隠すのではなく、その傷
を歴史として美しく顕在化させる。苔むした石、雨に濡れた瓦屋根、使い込まれた
木の床──これらは全て侘び寂びの美である。

この美意識は、完璧さを追求する西洋的な古典主義と対照的である。永遠の若さ
や完璧な対称性ではなく、朽ちゆく過程、その中で現れる真正さが評価される。

## 幽玄

「幽玄」は、深く捉えがたい美、言葉では表現しきれない神秘的な情趣を意味する。
能楽師、世阿弥が著書『風姿花伝』において能の美学の頂点として位置づけた。
月がかすんで見える夜景、霧の中に消えゆく山、舞台上の役者の一瞬の静止──
これらが幽玄を喚起する。

幽玄は「はっきりと見えないからこそ美しい」という逆説を内包している。全てを
明示せず、余白を残し、観る者の想像力に委ねる。この美学は俳句、水墨画、
庭園設計、そして現代のアニメーションにまで及ぶ日本的な表現の土台となって
いる。

## 現代への継承

三つの概念は現代の日本文化にも生きている。アニメ映画監督の宮崎駿の作品には
もののあわれが流れ、建築家の隈研吾の空間デザインには侘び寂びが宿り、ゲーム
デザイナーの小島秀夫の演出には幽玄が漂う。

これらの美意識は、日本独自のものでありながら、有限の生を生きる全ての人間
に共鳴する普遍的な感受性でもある。
`

/** Vietnamese pho history + preparation. */
const VIETNAMESE_CUISINE = `# Phở: Lịch sử và Cách chế biến

Phở là món ăn quốc hồn quốc túy của Việt Nam, một sự kết hợp tinh tế giữa
nước dùng trong vắt, bánh phở mềm mại và những lát thịt bò hoặc gà được
chế biến khéo léo. Món ăn này không chỉ là một bữa sáng phổ biến mà còn
là biểu tượng văn hóa ẩm thực của dân tộc Việt.

## Nguồn gốc lịch sử

Phở xuất hiện ở miền Bắc Việt Nam vào cuối thế kỷ XIX đến đầu thế kỷ XX,
trong giai đoạn thuộc địa Pháp. Có nhiều giả thuyết về nguồn gốc của
phở. Một giả thuyết phổ biến cho rằng phở là sự kết hợp giữa món "pot-au-feu"
của Pháp (một món hầm thịt bò) với phương pháp nấu nước dùng truyền thống
của Trung Hoa và hương vị bản địa Việt Nam.

Phở ban đầu xuất hiện ở Nam Định và Hà Nội, được các gánh hàng rong bán
dọc đường phố. Vào những năm 1950, sau khi đất nước chia cắt, người miền
Bắc di cư vào Nam đã mang theo món phở, và phở Nam Bộ dần phát triển thành
một phong cách riêng với nước dùng ngọt hơn và nhiều rau sống hơn.

## Nguyên liệu cơ bản

### Nước dùng
- Xương bò (xương ống, xương đuôi): 3 kg
- Gừng nướng: 100 g
- Hành tây nướng: 2 củ
- Quế: 2 thanh
- Hoa hồi: 4 cánh
- Thảo quả: 2 quả
- Đinh hương: 6 nụ
- Hạt mùi rang: 1 muỗng cà phê
- Muối, đường phèn, nước mắm

### Phần ăn
- Bánh phở tươi: 500 g
- Thịt bò (bắp, nạm, gầu, tái): 500 g
- Hành lá, ngò gai, rau húng quế
- Giá sống, chanh, ớt

## Cách chế biến nước dùng

Bước quan trọng nhất của phở là nấu nước dùng. Xương bò được chần qua
nước sôi để loại bỏ tạp chất, sau đó rửa sạch và ninh trong nồi lớn với
lượng nước vừa đủ. Quá trình ninh kéo dài từ sáu đến tám giờ, trong suốt
thời gian đó người nấu phải liên tục hớt bọt để nước dùng được trong vắt.

Gừng và hành tây được nướng trên bếp than cho đến khi hơi cháy xém, tạo
ra hương thơm đậm đà. Các loại gia vị như quế, hồi, thảo quả, đinh hương
được rang sơ trong chảo khô rồi cho vào túi vải và thả vào nồi nước
dùng. Muối được cho vào từ sớm, còn nước mắm và đường phèn được nêm ở
giai đoạn cuối để giữ hương vị tinh khiết.

## Bát phở hoàn hảo

Một bát phở Hà Nội đúng điệu có nước dùng trong, vị ngọt thanh tự nhiên
từ xương, hương thơm nhẹ nhàng của quế hồi nhưng không át đi vị thịt bò.
Bánh phở tươi được trụng qua nước sôi, xếp vào bát cùng với lát thịt bò
tái còn đỏ, thịt chín thái mỏng, hành lá và ngò gai thái nhuyễn. Nước
dùng sôi được chan vào bát ngay khi bưng ra, làm chín tái phần thịt tái
và tỏa hương thơm ngào ngạt.

Phở Nam Bộ ăn kèm đĩa rau sống phong phú: giá đỗ, rau húng quế, ngò gai,
lá chanh, cùng tương đen và tương ớt. Phở Hà Nội thì tối giản hơn: chỉ
thêm một chút chanh và ớt tươi.

## Giá trị văn hóa

Phở đã vượt ra khỏi biên giới Việt Nam và trở thành món ăn được yêu
thích toàn cầu. Từ Sài Gòn đến Paris, từ Hà Nội đến New York, mỗi bát
phở đều kể câu chuyện về sự kết hợp tinh tế giữa các nền văn hóa, đồng
thời giữ nguyên bản sắc độc đáo của người Việt Nam.
`

/** Arabic Alhambra architecture — RTL script test. */
const ARABIC_ARCHITECTURE = `# قصر الحمراء: روعة العمارة الإسلامية في الأندلس

يُعدّ قصر الحمراء في غرناطة، بإسبانيا، واحداً من أعظم الآثار المعمارية
في تاريخ الحضارة الإسلامية، وأحد أبرز شواهد الأندلس على ذروة التطور
الفني والعلمي الذي بلغه المسلمون في أوروبا خلال القرون الوسطى.

## التاريخ

بُني قصر الحمراء في القرن الثالث عشر والرابع عشر الميلادي على يد سلاطين
بني الأحمر، الذين حكموا مملكة غرناطة النصرية، وهي آخر معاقل المسلمين في
شبه الجزيرة الإيبيرية. بدأ البناء في عهد السلطان محمد الأول سنة 1238،
واستمر على مدى قرنين من الزمن حتى وصل إلى شكله المعروف اليوم في عهد
يوسف الأول ومحمد الخامس.

اسم "الحمراء" مشتق من اللون الأحمر للطين المستخدم في جدرانه الخارجية،
وقد أضفى على القصر طابعه المميز الذي يتلألأ عند غروب الشمس.

## العناصر المعمارية

### باحة الأسود

تُعدّ باحة الأسود من أشهر الفضاءات في القصر. تتوسطها نافورة محاطة باثني
عشر أسداً رخامياً، تعبر كل واحدة عن ساعة من ساعات النهار، في تصميم يجمع
بين الوظيفة الهندسية والرمزية الروحية. تحيط بالباحة 124 عموداً رخامياً
دقيقاً يدعم أقواساً مزدانة بالزخارف الجصية.

### قاعة السفراء

تعلو قاعة السفراء قبة خشبية منقوشة تمثل سماوات الإسلام السبع، وهي من
أدق الأعمال النجّارية الإسلامية. استُخدمت هذه القاعة لاستقبال السفراء
الأجانب، وتحتوي جدرانها على آيات قرآنية وأبيات شعرية محفورة بخط الثلث
الأندلسي.

### جنة العريف

تقع جنة العريف بجوار القصر الرئيسي، وهي حديقة صيفية صُمّمت لتكون مكاناً
للتأمل والسكينة. تحتوي على ممرات مائية وبحيرات ونوافير تعكس الفكرة
الإسلامية عن الجنة، حيث ترمز المياه إلى الحياة والطهارة.

## الخصائص الفنية

تتميز عمارة الحمراء بعدة سمات جوهرية:

- **الزخرفة النباتية**: تملأ الأسطح زخارف نباتية متشابكة تعرف بـ"الأرابسك"،
  وهي ترمز إلى الخلود والإبداع الإلهي.
- **الخط العربي**: يُعدّ عنصراً أساسياً، حيث تغطي آيات قرآنية وقصائد شعرية
  جدران القصر بخطوط متعددة كالثلث والنسخ والكوفي.
- **المقرنصات**: وهي زخارف معمارية تشبه أقراص العسل، تزين الأسقف والقبات
  وتخلق تأثيراً ضوئياً ساحراً.
- **الماء**: يُدمج في التصميم المعماري كعنصر حيوي، من خلال النوافير والبرك
  التي تعكس الضوء وتبرّد الأجواء.

## الإرث والحماية

بعد سقوط غرناطة في يد الملكين الكاثوليكيين عام 1492، تحوّل قصر الحمراء
إلى مقر ملكي مسيحي، ثم أُهمل لعدة قرون قبل أن تُعاد صيانته في القرن
التاسع عشر. سجّلته منظمة اليونسكو ضمن قائمة التراث العالمي عام 1984،
ليظل شاهداً على عبقرية الحضارة الإسلامية التي ازدهرت في الأندلس.

يستقبل القصر اليوم ما يزيد على مليوني زائر سنوياً، ويبقى مصدر إلهام
للمعماريين والفنانين من جميع أنحاء العالم.
`

/** German philosophy — Kant's Critique of Pure Reason. */
const GERMAN_PHILOSOPHY = `# Immanuel Kant: Die Kritik der reinen Vernunft

Immanuel Kants Werk "Kritik der reinen Vernunft", erstmals veröffentlicht
im Jahre 1781 und in zweiter Auflage 1787 überarbeitet, gilt als eines
der einflussreichsten philosophischen Werke der Moderne. Es markiert
einen Wendepunkt in der abendländischen Philosophie und begründet den
sogenannten Transzendentalen Idealismus.

## Das Problem der Metaphysik

Kants zentrale Fragestellung lautet: Wie ist Metaphysik als Wissenschaft
möglich? Vor Kant glaubten Rationalisten wie Leibniz und Wolff, die
menschliche Vernunft könne durch reines Denken Erkenntnisse über die
Welt gewinnen. Empiristen wie Hume hingegen behaupteten, alles Wissen
stamme aus der Erfahrung, und leugneten die Möglichkeit metaphysischer
Erkenntnis überhaupt.

Kant versucht, einen dritten Weg zu gehen. Er akzeptiert Humes Einsicht,
dass reine Vernunft allein keine Erkenntnis der Welt liefern kann, will
aber dennoch die Möglichkeit wissenschaftlicher Erkenntnis und
synthetischer Urteile a priori retten.

## Synthetische Urteile a priori

Die berühmte Unterscheidung Kants: Urteile sind entweder analytisch
(das Prädikat ist bereits im Subjektbegriff enthalten, etwa "Alle
Junggesellen sind unverheiratet") oder synthetisch (das Prädikat fügt
dem Subjekt etwas Neues hinzu). Erkenntnisse sind entweder a priori
(unabhängig von Erfahrung) oder a posteriori (aus Erfahrung).

Kants entscheidende These: Es gibt synthetische Urteile a priori. Die
Mathematik liefert dafür Beispiele ("7 + 5 = 12" fügt dem Begriff der
Summe aus 7 und 5 etwas Neues hinzu, ist aber dennoch notwendig wahr),
ebenso wie die Grundsätze der Naturwissenschaft ("Jede Veränderung hat
eine Ursache").

## Die transzendentale Ästhetik

Die Bedingungen der Möglichkeit solcher Urteile liegen laut Kant in den
Anschauungsformen Raum und Zeit. Raum und Zeit sind keine Eigenschaften
der Dinge an sich, sondern subjektive Formen, unter denen uns
Gegenstände erscheinen. Die Geometrie liefert synthetische Urteile a
priori, weil sie die Struktur des Raumes als unserer Anschauungsform
analysiert.

## Die transzendentale Analytik

Die Verstandeskategorien — Einheit, Vielheit, Substanz, Kausalität und
neun weitere — sind die Begriffe, durch die wir die Mannigfaltigkeit
der Anschauung zur Erkenntnis verarbeiten. Ohne diese Kategorien hätten
wir bloße Empfindungen, aber keine geordnete Erfahrung.

## Die kopernikanische Wende

Kants selbsterklärte "kopernikanische Wende" kehrt die traditionelle
Erkenntnisrelation um: Nicht der Geist richtet sich nach den Dingen,
sondern die Dinge richten sich nach der Struktur unseres Erkenntnis-
vermögens. Was wir erkennen, sind niemals die Dinge an sich, sondern
Erscheinungen — die Welt, wie sie uns durch Raum, Zeit und Kategorien
gegeben ist.

## Die Grenzen der Vernunft

Traditionelle metaphysische Fragen nach Gott, Freiheit und der
Unsterblichkeit der Seele liegen jenseits der Erfahrung und entziehen
sich daher der theoretischen Erkenntnis. Die Vernunft gerät in
Widersprüche, wenn sie versucht, über die Grenzen möglicher Erfahrung
hinauszugehen. Kant entwickelt eine "Dialektik" dieser Antinomien und
zeigt, dass rationale Theologie unmöglich ist.

## Wirkung

Die "Kritik der reinen Vernunft" prägte den deutschen Idealismus
(Fichte, Schelling, Hegel), die phänomenologische Tradition (Husserl,
Heidegger) und die analytische Philosophie (etwa Strawsons "The Bounds
of Sense"). Noch heute ist sie ein unverzichtbarer Bezugspunkt jeder
Erkenntnistheorie und Metaphysik.
`

/** Russian literature — Dostoevsky's Brothers Karamazov. */
const RUSSIAN_LITERATURE = `# Фёдор Достоевский: «Братья Карамазовы»

«Братья Карамазовы» — последний роман Фёдора Михайловича Достоевского,
опубликованный в 1879–1880 годах и считающийся вершиной его творчества.
Это обширное философское произведение о вере, сомнении, свободе воли и
нравственной ответственности человека.

## Сюжет

Действие романа разворачивается в вымышленном городке Скотопригоньевске
и сосредоточено вокруг семьи Карамазовых. Отец — Фёдор Павлович,
циничный и развратный помещик. У него четыре сына: страстный военный
офицер Дмитрий, рационалист-интеллектуал Иван, благочестивый послушник
монастыря Алёша, и незаконнорожденный слуга Смердяков.

Центральное событие — убийство Фёдора Павловича. Все три законных сына
оказываются в той или иной степени причастны к преступлению: Дмитрий
угрожал отцу публично, Иван своими идеями косвенно подстрекал к
убийству, а Смердяков совершил его физически. Дмитрий несправедливо
осуждён, и роман заканчивается его судебным процессом и ссылкой на
каторгу.

## Философские темы

### Проблема теодицеи

В главе «Бунт» Иван излагает брату Алёше свой знаменитый аргумент против
существования справедливого Бога: если мир создан всеблагим творцом,
почему страдают невинные дети? Иван приводит ужасающие примеры детских
страданий и заявляет, что даже если мировая гармония будет достигнута
ценой одной слезы ребёнка, он возвращает Богу «билет в вечность».

### Легенда о Великом Инквизиторе

Самая знаменитая глава романа — «поэма» Ивана о Великом Инквизиторе,
действие которой происходит в Севилье XVI века. Инквизитор арестовывает
вернувшегося на землю Христа и обвиняет его в том, что тот отверг три
искушения в пустыне — хлеб, чудо и власть — и тем самым возложил на
человечество невыносимое бремя свободы. Инквизитор утверждает, что
церковь исправила ошибку Христа, дав людям хлеб, таинство и авторитет
взамен свободы, которая им не по силам.

### Свобода и ответственность

Через фигуру старца Зосимы и его учение, переданное Алёшей, Достоевский
выдвигает противоположный тезис: свобода не бремя, а дар, и подлинная
нравственность возникает только в сознательном принятии ответственности
за «всех и за всё». Знаменитая формула Зосимы: «Каждый пред всеми за
всех виноват».

### Вера через сомнение

В отличие от традиционной религиозной литературы, Достоевский не
представляет веру как нечто данное. Алёша переживает собственный кризис
после смерти Зосимы; Дмитрий обретает духовное обращение лишь в тюрьме;
Иван сходит с ума от своих рационалистических построений. Вера у
Достоевского всегда проходит через горнило сомнения.

## Стиль и форма

Роман построен полифонически — в терминах Михаила Бахтина, который
использовал это произведение как главный пример в своей теории
«полифонического романа». Голоса героев звучат независимо от автора и
вступают в диалог между собой. Автор не даёт окончательной истины; она
возникает (или не возникает) в столкновении точек зрения.

## Влияние

«Братья Карамазовы» оказали колоссальное влияние на мировую литературу
и философию. Фридрих Ницше называл роман «гениальным»; Альберт Эйнштейн
говорил, что это величайшая книга, когда-либо написанная. Фрейд посвятил
роману отдельное эссе о комплексе отцеубийства. Экзистенциалисты —
Бердяев, Камю, Сартр — считали Достоевского своим предшественником.
`

// ── G. Long content (1) ─────────────────────────────────────────────────────

/**
 * RLHF survey — ~9000 char long-form doc. Tests truncation behavior
 * (ingest caps source at 50K chars) and whether index/overview can
 * synthesize a larger input.
 */
const RLHF_SURVEY = `# Reinforcement Learning from Human Feedback: A Comprehensive Survey

## Abstract

Reinforcement Learning from Human Feedback (RLHF) has emerged as the
dominant paradigm for aligning large language models with human
preferences. Since its popularization through InstructGPT in 2022 and
ChatGPT later that year, RLHF has become the standard final-stage
training procedure for nearly every major production LLM. This survey
traces the history, algorithms, practical challenges, and recent
alternatives to classical RLHF.

## 1. Historical Context

The idea of training agents from human preferences predates large
language models by decades. Early work in robotics asked humans to rank
agent trajectories rather than specify a reward function directly.
Christiano et al. (2017) from OpenAI demonstrated that preference-based
RL could train an Atari-playing agent with only a few hundred human
comparisons — a striking data efficiency result.

The transition to language models began with OpenAI's "Deep Reinforcement
Learning from Human Preferences" in 2019 and culminated in the
InstructGPT paper (Ouyang et al., 2022), which showed that a 1.3B-
parameter model trained with RLHF could outperform the 175B GPT-3 on
human preference evaluations. This result established RLHF as a tool for
aligning model behavior with user intent, not merely for task-specific
optimization.

## 2. The Classical Three-Stage Pipeline

RLHF as practiced in 2022–2024 comprises three stages:

### Stage 1: Supervised Fine-Tuning (SFT)

Starting from a pre-trained base language model, the model is fine-tuned
on a dataset of human-written (prompt, ideal-response) pairs. This
teaches the model the format, register, and general task expectations.
The dataset size ranges from a few thousand to hundreds of thousands of
examples, and the training objective is standard cross-entropy over
next-token prediction.

SFT alone produces a model that can respond coherently, but its outputs
often lack the quality, safety, and helpfulness characteristics humans
prefer. The subsequent stages add those characteristics.

### Stage 2: Reward Modeling

A separate reward model is trained to predict human preferences. Human
annotators are presented with pairs of model outputs for the same
prompt and asked which is better. The reward model — typically
initialized from the SFT model but with the final layer replaced by a
scalar head — is trained with a pairwise loss:

    L(θ) = -E[log σ(r_θ(x, y_w) - r_θ(x, y_l))]

where y_w is the preferred response and y_l is the less preferred one.
The reward model learns a scalar function r(x, y) over (prompt, response)
pairs that approximates human judgment.

Reward modeling is the most data-hungry and quality-sensitive stage.
Tens of thousands of paired comparisons are typical, and noisy labels
can cause the reward model to reward superficial features (length,
verbosity, refusal) rather than actual quality — a phenomenon called
reward hacking.

### Stage 3: Policy Optimization

The SFT model becomes the policy π_θ, and Proximal Policy Optimization
(PPO) is run with the reward model providing the scalar reward signal.
A KL divergence penalty against the SFT reference policy prevents the
policy from drifting too far from fluent language. The effective
objective is:

    max_θ E[r_θ(x, y) - β · KL(π_θ(·|x) || π_SFT(·|x))]

PPO is notoriously finicky: learning rate, KL coefficient, batch size,
value function, and clipping parameters all interact nontrivially. Many
teams have reported that reproducing RLHF results at scale required
weeks of hyperparameter tuning.

## 3. Practical Challenges

### Reward Hacking

Policies can exploit reward model weaknesses. Common failure modes
include excessive length (longer responses often score higher under
preference models), sycophancy (agreeing with the user regardless of
correctness), and refusal escalation (over-cautious "I can't help with
that" responses). Careful reward shaping and adversarial evaluation are
required.

### Distribution Shift

As the policy improves, it generates responses the reward model has
never seen, leading to unreliable reward estimates. This motivates
iterative RLHF: collect new preferences on the updated policy, retrain
the reward model, and continue. Modern pipelines run multiple iterations.

### Annotation Cost and Quality

High-quality preference data is expensive. A single comparison pair may
take an annotator 2–5 minutes for complex prompts, and inter-annotator
agreement on subjective qualities can be low. Techniques like redundant
labeling, disagreement resolution, and annotator training are standard
practice.

### Diversity Collapse

RL-trained models often produce less diverse outputs than the SFT
baseline. They optimize toward a single mode of the reward distribution,
sometimes producing templated or repetitive responses across different
prompts. Temperature tuning and sampling adjustments only partially
mitigate this.

## 4. Alternatives and Extensions

### Direct Preference Optimization (DPO)

Rafailov et al. (2023) showed that the RLHF objective can be reformulated
to avoid training a separate reward model entirely. DPO directly
optimizes the policy on preference pairs with a closed-form loss
derived from the Bradley-Terry model. This makes RLHF significantly
simpler to implement and more compute-efficient, with quality comparable
to PPO in many benchmarks. DPO has become the default choice for many
recent models.

### Rejection Sampling Fine-Tuning (RFT)

Rather than RL, some teams sample N responses per prompt, score them
with the reward model, and fine-tune on the highest-scoring ones. This
is simpler than PPO and avoids the KL penalty complications but can
plateau earlier.

### Constitutional AI (CAI)

Anthropic's Constitutional AI replaces human feedback at the preference
stage with model-generated feedback guided by a written "constitution"
(a set of principles). The model critiques and revises its own outputs,
producing preference data without human annotation on every comparison.
Claude was trained with this method.

### RLAIF

RL from AI Feedback generalizes CAI: use one model (often a larger or
specialized one) to judge responses from another. This reduces human
annotation cost and can scale to new tasks, at the cost of potentially
inheriting biases from the judge model.

### KTO, IPO, and Other Preference Objectives

Recent work has proposed alternative losses to DPO — Kahneman-Tversky
Optimization (KTO), Identity Preference Optimization (IPO), and others
— that trade off robustness to noisy labels, stability of training,
and quality of the resulting policy. Empirical comparisons are
ongoing.

## 5. Integration with Chain-of-Thought and Reasoning

Recent "reasoning" models (OpenAI o1/o3, DeepSeek-R1, Qwen-3-Reasoning)
use a different paradigm: reinforcement learning with verifiable
rewards on reasoning tasks. Instead of preference data, the model is
rewarded for producing correct answers on math and code problems, with
the chain-of-thought serving as an intermediate scratchpad. This is
sometimes called "RL from verifiable rewards" and is distinct from
RLHF proper, though it shares algorithmic machinery.

Some teams combine both: RLHF for alignment on conversational tasks,
and verifiable-reward RL for reasoning capability. The relative
contribution of each is an open empirical question.

## 6. Open Problems

- **Generalization**: preferences collected on one population (e.g.,
  English-speaking U.S. annotators) may not transfer to users in other
  contexts.
- **Adversarial robustness**: RLHF-trained models can still be jailbroken
  through specific prompt patterns; alignment is not a finished problem.
- **Interpretability**: the learned reward model is a black box;
  understanding what features it actually rewards requires separate
  analysis.
- **Scaling**: does RLHF's effectiveness continue at ever-larger model
  scales, or do alternative alignment paradigms become necessary?

## 7. Conclusion

RLHF transformed language modeling from raw text prediction into
intentional assistant design. Its three-stage pipeline remains the
backbone of production LLMs, though DPO and related methods have
simplified the algorithmic core. As models grow more capable, RLHF and
its descendants will continue to evolve — and the open problems around
generalization, robustness, and interpretability will only grow in
importance.
`

// ── Sweep-chain resolver (for the sweep-chained scenario) ──────────────────

/**
 * Stub doc that introduces Layer Normalization. Used in sweep-chained
 * scenario as the second ingest that should satisfy the missing-page
 * review produced by missing-page-trigger-en.
 */
const LAYER_NORM_RESOLVER = `# Layer Normalization

Layer Normalization (LayerNorm) is a normalization technique introduced
by Ba, Kiros, and Hinton in 2016. Unlike Batch Normalization, which
normalizes across the batch dimension, LayerNorm normalizes across the
feature dimension — computing the mean and variance per sample and per
timestep (for sequential data).

## Formula

For a feature vector x of dimension d, LayerNorm computes:

    μ = (1/d) Σ x_i
    σ² = (1/d) Σ (x_i − μ)²
    y = γ · (x − μ) / √(σ² + ε) + β

where γ and β are learnable scale and shift parameters and ε is a small
constant for numerical stability.

## Usage in Transformers

LayerNorm is applied in two places in a standard transformer block:
after the self-attention sublayer and after the feed-forward sublayer.
The "Post-LN" variant puts the normalization after the residual
connection; the "Pre-LN" variant (used in modern models like LLaMA)
applies normalization before the sublayer, which is more stable during
training.

## Advantages

- Independent of batch size, making it usable at batch size 1 (important
  for RL and online learning).
- Stable across varying sequence lengths.
- Simple to implement and has no state at inference time beyond the
  learned parameters.
`

// ── Registry and materialize ────────────────────────────────────────────────

export const REAL_CONTENT_DOCS: RealContentDoc[] = [
  // A. Baseline (4)
  { filename: "rope-paper.md", content: ROPE_PAPER },
  { filename: "flash-attention-paper.md", content: FLASH_ATTENTION_PAPER },
  { filename: "lora-paper.md", content: LORA_PAPER },
  { filename: "transformer-survey-zh.md", content: TRANSFORMER_SURVEY_ZH },
  // B. Non-English languages (5)
  { filename: "japanese-philosophy-ja.md", content: JAPANESE_PHILOSOPHY },
  { filename: "vietnamese-cuisine-vi.md", content: VIETNAMESE_CUISINE },
  { filename: "arabic-architecture-ar.md", content: ARABIC_ARCHITECTURE },
  { filename: "german-philosophy-de.md", content: GERMAN_PHILOSOPHY },
  { filename: "russian-literature-ru.md", content: RUSSIAN_LITERATURE },
  // C. Review triggers (3)
  { filename: "missing-page-trigger-en.md", content: MISSING_PAGE_TRIGGER },
  { filename: "duplicate-trigger-en.md", content: DUPLICATE_TRIGGER },
  { filename: "contradiction-trigger-en.md", content: CONTRADICTION_TRIGGER },
  // D. Knowledge graph / entity (2)
  { filename: "biographical-hinton-en.md", content: BIOGRAPHICAL_HINTON },
  { filename: "rich-graph-survey-en.md", content: RICH_GRAPH_SURVEY },
  // E. Domain diversity (3)
  { filename: "legal-saas-tos-en.md", content: LEGAL_SAAS_TOS },
  { filename: "recipe-thai-curry-en.md", content: RECIPE_THAI_CURRY },
  { filename: "math-heavy-maxwell-en.md", content: MATH_HEAVY_MAXWELL },
  // G. Long content (1)
  { filename: "rlhf-survey-en.md", content: RLHF_SURVEY },
  // Sweep-chain resolver (auxiliary)
  { filename: "layer-norm-resolver-en.md", content: LAYER_NORM_RESOLVER },
]

export async function materializeRealContent(
  targetDir: string,
): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true })
  for (const doc of REAL_CONTENT_DOCS) {
    await fs.writeFile(
      path.join(targetDir, doc.filename),
      doc.content,
      "utf-8",
    )
  }
}
