# RoFormer: Enhanced Transformer with Rotary Position Embedding

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
