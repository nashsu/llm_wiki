# LoRA: Low-Rank Adaptation of Large Language Models

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
