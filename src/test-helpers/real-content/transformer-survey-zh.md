# Transformer 架构综述

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
