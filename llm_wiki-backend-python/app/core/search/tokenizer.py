"""Search tokenizer for English and Chinese text.

Provides:
- English: lowercase + split by non-alphanumeric + stopword removal
- Chinese: CJK bigram tokenization (no external dependency)
- Auto language detection based on CJK character ratio
"""

import re
import unicodedata

# ---------------------------------------------------------------------------
# Stopword lists
# ---------------------------------------------------------------------------

_ENGLISH_STOPWORDS: set[str] = {
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "can",
    "could", "shall", "should", "may", "might", "must",
    "of", "in", "on", "at", "by", "for", "with", "about", "against",
    "between", "into", "through", "during", "before", "after", "above",
    "below", "from", "up", "down", "to", "and", "but", "or", "nor",
    "not", "so", "yet", "as", "if", "because", "while", "when", "where",
    "how", "what", "which", "who", "whom", "this", "that", "these",
    "those", "it", "its", "we", "you", "they", "them", "their", "our",
    "some", "any", "each", "every", "all", "both", "few", "more", "most",
    "other", "no", "such", "only", "own", "same", "here", "there",
    "then", "than", "too", "very", "just", "also", "i", "me", "my",
    "myself", "your", "yours", "yourself", "he", "him", "his", "she",
    "her", "hers", "itself", "themselves", "what", "which", "why",
}

_CHINESE_STOPWORDS: set[str] = {
    "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都",
    "一", "个", "上", "也", "很", "到", "说", "要", "去", "你", "会",
    "着", "没", "看", "好", "自己", "这", "他", "她", "它", "们",
    "那", "什么", "我们", "你们", "它们", "她们",
    "因为", "所以", "但是", "如果", "虽然", "而且", "或者", "然后",
    "不过", "因而", "因此", "于是", "从而", "能够", "可以", "应该",
    "需要", "可能", "必须", "已经", "正在", "将要", "还是",
    "从", "对", "被", "把", "向", "让", "给", "跟", "与", "以",
    "按", "按照", "除了", "根据", "关于", "对于", "为了",
    "通过", "经过", "由于", "随着", "及", "及其", "等", "之",
    "中", "其", "其中", "方面", "者", "第", "每", "各",
}

_ALL_STOPWORDS = _ENGLISH_STOPWORDS | _CHINESE_STOPWORDS

# ---------------------------------------------------------------------------
# Pattern helpers
# ---------------------------------------------------------------------------

# Matches a single CJK character (CJK Unified Ideographs)
_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]")

# Split English text into words on non-alphanumeric boundaries
_EN_WORD_SPLIT = re.compile(r"[^a-zA-Z0-9]+")

# Characters that are NOT CJK and not ASCII letters/digits
_NON_CJK_ASCII = re.compile(r"[^\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaffa-zA-Z0-9]+")


def _is_cjk_char(ch: str) -> bool:
    """Return True if *ch* is a CJK Unified Ideograph character."""
    return bool(_CJK_RE.match(ch))


def _cjk_bigrams(text: str) -> list[str]:
    """Extract CJK bigrams from *text*.

    Non-CJK characters are stripped first.  A string of *n* CJK characters
    produces ``n - 1`` bigrams.
    """
    chars = [c for c in text if _is_cjk_char(c)]
    return [chars[i] + chars[i + 1] for i in range(len(chars) - 1)]


def _english_words(text: str) -> list[str]:
    """Lowercase, split on non-alphanumeric, return filtered words."""
    words = _EN_WORD_SPLIT.split(text.lower())
    return [w for w in words if len(w) > 0 and w not in _ALL_STOPWORDS]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


class SearchTokenizer:
    """Tokenize text using English word-splitting or CJK bigram analysis.

    Usage::

        tok = SearchTokenizer()
        tokens = tok.tokenize("Python programming language")
        # -> ["python", "programming"]
    """

    def detect_language(self, text: str) -> str:
        """Detect whether *text* is primarily Chinese or English.

        Returns ``"zh"`` if more than 30% of the characters are CJK,
        otherwise ``"en"``.
        """
        if not text:
            return "en"
        cjk_count = sum(1 for c in text if _is_cjk_char(c))
        ratio = cjk_count / len(text)
        return "zh" if ratio > 0.30 else "en"

    def tokenize(self, text: str, lang: str = "auto") -> list[str]:
        """Tokenize *text* according to *lang*.

        Parameters
        ----------
        text:
            Input text (English, Chinese, or mixed).
        lang:
            One of ``"auto"``, ``"zh"``, or ``"en"``.  ``"auto"`` uses
            :meth:`detect_language` to decide.

        Returns
        -------
        list[str]:
            Normalised tokens.  English tokens are lowercased and
            stopwords are removed.  Chinese tokens are CJK bigrams
            (also filtered against a common stopword set).
        """
        if not text:
            return []

        if lang == "auto":
            lang = self.detect_language(text)

        if lang == "zh":
            # Chinese path: bigram CJK chars, also extract any English words
            tokens = _cjk_bigrams(text)
            tokens = [t for t in tokens if t not in _ALL_STOPWORDS]
            # Also grab English words present in the text
            en_words = _english_words(text)
            tokens.extend(w for w in en_words if w not in tokens)
        else:
            # English path: word split + stopword filter
            tokens = _english_words(text)

        return tokens
