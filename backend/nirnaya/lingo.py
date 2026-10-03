"""Hindi and English on calls: what language the caller speaks, English for the agents, and the caller's own
language back.

A caller may speak English, Hindi (Twilio's hi-IN recogniser writes it in Devanagari) or Hinglish (Hindi in
Latin letters, mixed with English). The agents read English and Hinglish; Devanagari is turned into words they
read: the free model translates it when one is on (it sees the tokenised text only, and every number must come
through unchanged), otherwise a banking glossary plus transliteration does ("मेरा 2450 रुपये का पेमेंट फेल हो
गया" → "mera 2450 rupees ka payment failed ho gaya"), which the Hinglish rules understand.

Back to the caller: a Hindi caller hears Hindi. The office's fixed lines have Hindi versions here; anything
else (a case's answer) is translated by the model, with every number checked, or spoken as it is (the
Hinglish templates already are, and the bilingual voice reads Indian English).
"""
from __future__ import annotations

import re

DEVANAGARI = re.compile(r"[ऀ-ॿ]")
HINGLISH = {"mera", "meri", "mere", "nahi", "nahin", "hua", "hui", "paisa", "paise", "kal", "abhi", "kya", "wapas",
            "gaya", "gaye", "kiya", "hai", "hain", "kat", "mujhe", "aap", "aapka", "bhai", "ji", "karo", "kijiye",
            "chahiye", "kaise", "kab", "kyun", "bataiye", "batao", "haan", "theek"}
ASK_HINDI = re.compile(r"\b(hindi|हिंदी|हिन्दी)\b", re.I)
ASK_ENGLISH = re.compile(r"\b(english|इंग्लिश|अंग्रेज़ी|अंग्रेजी)\b", re.I)

# longest first: phrases before the words in them
GLOSSARY = sorted({
    "मैंने नहीं किया": "not done by me", "मैंने नहीं की": "not done by me", "मेरे द्वारा नहीं": "not done by me",
    "नहीं धन्यवाद": "no thank you", "बस इतना ही": "that's all", "और कुछ नहीं": "nothing else",
    "पैसे वापस": "money back", "दो बार": "twice", "कट गया": "kat gaya", "कट गए": "kat gaye", "कट गई": "kat gaya",
    "नहीं आया": "nahi aaya", "नहीं मिला": "nahi mila", "दिन पहले": "days ago", "हो गया": "ho gaya",
    "कस्टमर आईडी": "customer ID", "मोबाइल नंबर": "mobile number",
    "पेमेंट": "payment", "पेमेन्ट": "payment", "भुगतान": "payment", "फेल": "failed", "फ़ेल": "failed",
    "असफल": "failed", "रिफंड": "refund", "रिफ़ंड": "refund", "ट्रांजैक्शन": "transaction",
    "ट्रांज़ैक्शन": "transaction", "ट्रांसेक्शन": "transaction", "लेनदेन": "transaction", "यूपीआई": "UPI",
    "कार्ड": "card", "अकाउंट": "account", "खाता": "account", "खाते": "account", "बैलेंस": "balance",
    "स्टेटमेंट": "statement", "केवाईसी": "KYC", "ब्लॉक": "block", "डेबिट": "debited", "क्रेडिट": "credited",
    "फ्रॉड": "fraud", "फ़्रॉड": "fraud", "धोखाधड़ी": "fraud", "धोखा": "fraud", "स्कैम": "scam", "हैक": "hacked",
    "मर्चेंट": "merchant", "दुकान": "shop", "ऑर्डर": "order", "रुपये": "rupees", "रुपए": "rupees",
    "रूपये": "rupees", "रुपया": "rupees", "रुपयों": "rupees", "डबल": "double", "गलत": "wrong", "ग़लत": "wrong",
    "आईडी": "ID", "नंबर": "number", "बैंक": "bank", "ओटीपी": "OTP", "पिन": "PIN", "लिमिट": "limit",
    "वापस": "wapas", "पैसा": "paisa", "पैसे": "paisa", "कटा": "kata", "कटे": "kata", "नहीं": "nahi", "मेरा": "mera",
    "मेरी": "meri", "मेरे": "mere", "कल": "kal", "आज": "aaj", "दिन": "din", "पहले": "pehle", "हुआ": "hua",
    "गया": "gaya", "है": "hai", "हैं": "hain", "क्या": "kya", "अभी": "abhi", "किया": "kiya", "धन्यवाद": "thank you",
    "शुक्रिया": "thank you", "अलविदा": "bye", "हाँ": "yes", "हां": "yes", "जी": "ji", "नहीं जी": "no",
    "हिंदी": "Hindi", "हिन्दी": "Hindi", "इंग्लिश": "English",
}.items(), key=lambda kv: -len(kv[0]))

_CONS = {"क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
         "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
         "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh",
         "ष": "sh", "स": "s", "ह": "h", "क़": "q", "ख़": "kh", "ग़": "g", "ज़": "z", "फ़": "f", "ड़": "r", "ढ़": "rh"}
_VOW = {"अ": "a", "आ": "aa", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u", "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o",
        "औ": "au", "ऑ": "o", "ॲ": "e"}
_MATRA = {"ा": "aa", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au",
          "ॅ": "e", "ॉ": "o"}
_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")
NUM = re.compile(r"\d[\d,]*(?:\.\d+)?")


def has_devanagari(text: str) -> bool:
    return bool(DEVANAGARI.search(text or ""))


def detect(text: str) -> str:
    """"hi" for Hindi (Devanagari, or Hindi in Latin letters), "en" otherwise."""
    if has_devanagari(text):
        return "hi"
    words = re.findall(r"[a-z]+", (text or "").lower())
    return "hi" if sum(w in HINGLISH for w in words) >= 2 else "en"


def transliterate(text: str) -> str:
    """Devanagari in Latin letters, the way people type Hinglish: मेरा → mera, पैसा → paisa, कट → kat.
    Only the Devanagari runs change; words already in Latin letters stay as they are."""
    return re.sub(r"[\u0900-\u097F]+", lambda m: _word(m.group()), text.translate(_DIGITS))


def _word(text: str) -> str:
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if ch + nxt in _CONS and nxt == "़":          # a consonant with its nukta
            ch, i = ch + nxt, i + 1
            nxt = text[i + 1] if i + 1 < n else ""
        if ch in _CONS:
            out.append(_CONS[ch])
            if nxt in _MATRA:
                out.append(_MATRA[nxt])
                i += 2
                continue
            if nxt == "्":                           # virama: no vowel
                i += 2
                continue
            out.append("a")                               # the inherent vowel (dropped at the end of a word below)
        elif ch in _VOW:
            out.append(_VOW[ch])
        elif ch in ("ं", "ँ"):                  # anusvara, chandrabindu
            out.append("n")
        elif ch == "ः":
            out.append("h")
        elif ch in ("।", "॥"):                  # danda
            out.append(".")
        elif ch == "़":
            pass
        else:
            out.append(ch)
        i += 1
    s = "".join(out)
    s = re.sub(r"(?<=[a-z]{2})(?<!a)a$", "", s)           # schwa deletion: kata → kat (not the long aa of meraa)
    s = re.sub(r"aa$", "a", s)                            # meraa → mera, paisaa → paisa
    return s


def rules_english(text: str) -> str:
    """Devanagari into words the agents' rules read: the glossary first, then transliteration."""
    s = text.translate(_DIGITS)
    for hi, en in GLOSSARY:
        s = re.sub(rf"(?<![ऀ-ॿ]){re.escape(hi)}(?![ऀ-ॿ])", en, s)
    return re.sub(r"\s+", " ", transliterate(s)).strip()


def _numbers(text: str) -> set[str]:
    return {n.replace(",", "").rstrip(".") for n in NUM.findall((text or "").translate(_DIGITS))}


def numbers_kept(src: str, out: str) -> bool:
    """Every number in the source is in the translation, and the translation adds none."""
    a, b = _numbers(src), _numbers(out)
    return a == b


def for_agents(text: str, llm=None, tokeniser=None) -> dict:
    """{"text": what the agents read, "lang": "hi" | "en", "via": "model" | "rules" | "as is", "original": text}"""
    text = (text or "").strip()
    lang = detect(text)
    if not has_devanagari(text):
        return {"text": text, "lang": lang, "via": "as is", "original": text}
    if llm is not None and getattr(llm, "enabled", False) and tokeniser is not None:
        masked, found = tokeniser.tokenise(text)
        got = llm.translate(masked, "English")
        if got and numbers_kept(masked, got) and not has_devanagari(got):
            for f in found:   # the agents' intake tokenises again; here the caller's own numbers come back
                raw = tokeniser.detokenise(f["token"])
                if raw:
                    got = got.replace(f["token"], raw)
            return {"text": got, "lang": "hi", "via": "model", "original": text}
    return {"text": rules_english(text), "lang": "hi", "via": "rules", "original": text}


# ── back to the caller ──────────────────────────────────────────────────────
HI = {
    "greeting": "नमस्ते, मैं निर्णय हूँ, आपकी सपोर्ट असिस्टेंट। आपके पेमेंट में मैं आपकी क्या मदद कर सकती हूँ?",
    "greeting_named": "नमस्ते {name} जी, मैं निर्णय हूँ, आपकी सपोर्ट असिस्टेंट। आपके पेमेंट में मैं आपकी क्या मदद कर सकती हूँ?",
    "press_2": "हिंदी में बात करने के लिए 2 दबाएँ, या हिंदी में बोलिए।",
    "recorded": "यह कॉल गुणवत्ता और रिकॉर्ड के लिए रिकॉर्ड की जा रही है।",
    "anything_else": "क्या मैं आपकी और कोई मदद कर सकती हूँ?",
    "one_moment": "एक पल, मैं अभी देख रही हूँ।",
    "still": "अभी देख रही हूँ।",
    "again": "माफ़ कीजिए, मैं समझ नहीं पाई। क्या आप दोबारा बोलेंगे?",
    "silence_bye": "मुझे कुछ सुनाई नहीं दे रहा, इसलिए मैं कॉल समाप्त कर रही हूँ। धन्यवाद, नमस्ते।",
    "lost": "माफ़ कीजिए, यह कॉल बीच में टूट गई। कृपया दोबारा कॉल करें। नमस्ते।",
    "cannot_help": "माफ़ कीजिए, इस लाइन पर मैं इसमें मदद नहीं कर सकती। नमस्ते।",
    "too_long": "इसमें थोड़ा ज़्यादा समय लग रहा है। मैं आपको जवाब मैसेज पर भेज दूँगी। धन्यवाद, नमस्ते।",
    "only_customers": "माफ़ कीजिए, यह लाइन केवल रजिस्टर्ड ग्राहकों के लिए है। नमस्ते।",
    "switched": "ठीक है, अब हम हिंदी में बात करेंगे। बताइए, आपके पेमेंट में क्या परेशानी है?",
}
EN = {
    "press_2": "For Hindi, press 2.",
    "switched_en": "Sure, let's continue in English. How can I help you with your payment?",
    "recorded": "This call is recorded for quality and our records.",
    "anything_else": "Is there anything else I can help you with?",
    "one_moment": "One moment, I'm checking that for you.",
    "still": "Still checking.",
    "again": "Sorry, I didn't catch that. Could you say it again?",
    "silence_bye": "I can't hear anything, so I'll end the call now. Thank you for contacting us. Goodbye!",
    "lost": "Sorry, I lost track of this call. Please call again. Goodbye.",
    "cannot_help": "Sorry, I can't help on this line. Goodbye.",
    "too_long": "This is taking a little longer than usual. I'll send you the answer by message. Thank you for contacting us. Goodbye!",
    "only_customers": "Sorry, this line only takes calls from registered customers. Goodbye.",
}
# the office's own fixed lines (channels/hub.py), as a Hindi caller hears them
FIXED_HI = [
    (re.compile(r"^To look into a payment for you, please tell me your registered mobile number, or your customer ID\.?",
                re.I), "आपका पेमेंट देखने के लिए कृपया अपना रजिस्टर्ड मोबाइल नंबर या कस्टमर आईडी बताइए।"),
    (re.compile(r"^Thank you, (\w+)\. I've found your account\.\s*", re.I), "धन्यवाद {0} जी, आपका अकाउंट मिल गया है। "),
    (re.compile(r"^You're welcome!.*$", re.I), "आपका स्वागत है! पेमेंट से जुड़ी कोई और बात हो तो बेझिझक बताइए।"),
    (re.compile(r"^Thank you for contacting us\. Goodbye!?$", re.I), "हमसे संपर्क करने के लिए धन्यवाद। नमस्ते!"),
    (re.compile(r"^How can I help you with your payment\??$", re.I), "बताइए, आपके पेमेंट में मैं क्या मदद करूँ?"),
    (re.compile(r"^Your case (NR-\d+) is with a specialist for approval\..*$", re.I),
     "आपका केस {0} अप्रूवल के लिए एक स्पेशलिस्ट के पास है। पूरा होते ही मैं आपको बताऊँगी।"),
    (re.compile(r"^I'm still checking case (NR-\d+)\..*$", re.I), "मैं अभी केस {0} देख रही हूँ। थोड़ी देर में जवाब मिलेगा।"),
]


def phrase(key: str, lang: str, **kw) -> str:
    table = HI if lang == "hi" else EN
    return (table.get(key) or EN.get(key) or "").format(**kw)


def for_caller(text: str, lang: str, llm=None) -> dict:
    """{"text": what the caller hears, "english": the agents' words, "via": "fixed" | "model" | "as is"}"""
    if lang != "hi" or not text:
        return {"text": text, "english": text, "via": "as is"}
    out, rest = "", text
    for rx, hi in FIXED_HI:
        m = rx.match(rest)
        if m:
            out += hi.format(*m.groups())
            rest = rest[m.end():].strip()
            if not rest:
                return {"text": out.strip(), "english": text, "via": "fixed"}
    if llm is not None and getattr(llm, "enabled", False):
        got = llm.translate(rest, "Hindi (Devanagari script; keep digits, ₹ amounts and case numbers exactly as written)")
        if got and numbers_kept(rest, got) and has_devanagari(got):
            return {"text": (out + " " + got).strip(), "english": text, "via": "model"}
    return {"text": (out + " " + rest).strip(), "english": text, "via": "fixed" if out else "as is"}
