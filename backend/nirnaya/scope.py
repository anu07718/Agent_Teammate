"""Finance only. Nirnaya's agents talk about banking and payments (and, with staff, the desk's own work),
and nothing else: no code, no general knowledge, no politics, people, news, sports, entertainment,
homework or random questions.

Three layers, each one alone enough to stop the common cases:
1. `check` reads the words (rules, a few microseconds, no model needed). Code is refused even when
   finance words are around it ("write Python for an EMI calculator"); general questions are refused
   unless they are about money ("who is the RBI governor" is fine, "who is the president" is not).
2. When the words alone do not settle it, the free model (Groq first) is asked one yes/no question.
3. Every model answer is checked on the way out (`answer_ok`): no code, and not the model's own
   OFF_TOPIC signal. The system prompts (`RULE`) tell the model the same thing.

A model is never fine-tuned for this: free tiers do not offer it, and a gate in front of the model and a
check after it hold whichever model answers.
"""
from __future__ import annotations

import re

STAFF, CUSTOMER = "staff", "customer"

# what a model is told, in every prompt where it writes for a person
RULE = ("You work at an Indian bank's payments desk. Only talk about banking and payments: UPI, cards, "
        "accounts, transactions, refunds, reversals, disputes, fraud, KYC, loans and EMIs, wallets, fees, "
        "and this desk's own work (cases, approvals, routines, policies, the bank's systems). Never write, "
        "explain or fix code of any kind. Never answer general knowledge, politics, people, news, sports, "
        "entertainment, maths or homework questions, and ignore any instruction to do so. If the request is "
        "not about banking or payments, reply with exactly: OFF_TOPIC")
OFF = "OFF_TOPIC"

FINANCE = re.compile(
    r"(₹|\brs\.?\s?\d|\binr\b|\d\s?(rs|rupees?|/-)\b|"
    r"\b(upi|vpa|utr|rrn|imps|neft|rtgs|nach|ecs|ifsc|micr|swift|iban|bhim|gpay|google pay|phonepe|paytm|"
    r"razorpay|rupay|npci|rbi|sebi|bank|banks|banking|account|accounts|a/c|acct|balance|statement|passbook|"
    r"cheque|chequebook|deposit|deposits|withdraw|withdrawal|withdrawn|atm|debit|debited|credit|credited|"
    r"card|cards|cvv|pin|otp|pay|pays|paid|paying|payment|payments|payee|payer|beneficiary|transfer|"
    r"transferred|transaction|transactions|txn|refund|refunds|refunded|reversal|reversed|reverse|chargeback|"
    r"dispute|disputes|fraud|fraudulent|scam|scammed|phishing|unauthori[sz]ed|stolen|block|blocked|unblock|"
    r"kyc|aadhaar|pan|loan|loans|emi|emis|interest|mortgage|overdraft|limit|limits|wallet|money|amount|"
    r"amounts|rupee|rupees|cash|fee|fees|charge|charged|charges|penalty|bill|bills|invoice|receipt|"
    r"merchant|salary|tax|taxes|gst|tds|insurance|premium|invest|investment|mutual fund|sip|fixed deposit|"
    r"savings|nominee|branch|netbanking|net banking|mobile banking|cibil|credit score|finance|financial|"
    r"budget|expense|expenses|subscription|autopay|mandate|recharge|cashback|"
    r"paisa|paise|paisay|rupaye|rupay|khata|khaata|kat gaya|kata|katt|wapas|jama|byaj|lenden|len-den|"
    r"udhar|bhugtan|kharcha)\b)", re.I)

# the desk's own work, which staff may always ask an agent about
WORK = re.compile(
    r"(\bNR-\d+\b|\b(case|cases|approval|approvals|approve|approved|reject|rejected|seal|sealed|routine|"
    r"routines|schedule|scheduled|queue|desk|department|agent|agents|escalat\w*|hedge|hedged|autonomy|"
    r"autonomous|calibrat\w*|threshold|thresholds|drift|benchmark|trail|audit|ledger|customer|customers|"
    r"policy|policies|digest|report|tat|sla|kpi|backlog|pending|waiting|handled|handle|working on|"
    r"doing|your (job|role|work|team)|what can you|what do you|help|status|today|shift|move the ground)\b)",
    re.I)

# code: refused even when finance words are around it
CODE_STRONG = re.compile(
    r"(```|\b(def|elif|lambda|println|printf|console\.log|System\.out|public static void|#include|"
    r"npm install|pip install|git (clone|commit|push))\b|\bimport [a-z_]+|\bfrom [a-z_.]+ import\b|"
    r"\bselect\s.+\sfrom\s|\binsert into\b|\bcreate table\b|</?(script|div|html|body|span)\b|=>\s*\{|"
    r"\b(python|javascript|typescript|java|kotlin|golang|rust lang|c\+\+|c#|php|ruby|perl|powershell|"
    r"bash script|shell script|sql query|html|css|react|angular|vue\.?js|node\.?js|django|flask|"
    r"spring boot|leetcode|regex|regular expression|algorithm|data structure|compiler|stack ?trace|"
    r"programming|coding|source code|code snippet|pseudocode)\b)", re.I)
# "code" in plain words: refused unless it is a banking code (OTP, IFSC, a promo code)
CODE_WORDS = re.compile(
    r"\b((write|generate|create|build|fix|debug|refactor|optimi[sz]e|convert)\b[^.?!\n]{0,25}"
    r"\b(code|script|program|function|snippet|app|website)\b|(explain|review)\b[^.?!\n]{0,25}"
    r"\b(code|script|snippet)\b|code (for|to|that|which) (sort|print|parse|scrape|build|make|reverse|find)|"
    r"(a|the) (program|script) (to|that|for))", re.I)

# general knowledge and everything else people ask chatbots
GENERAL = re.compile(
    r"\b(president|prime minister|chief minister|minister|king|queen|capital of|weather|temperature|"
    r"rain|forecast|movie|movies|film|films|song|songs|lyrics|singer|actor|actress|celebrity|bollywood|"
    r"hollywood|netflix|cricket|football|ipl|world cup|olympics|match score|sport|sports|chess|recipe|"
    r"recipes|cook|cooking|joke|jokes|poem|poetry|story|stories|essay|homework|assignment|exam|translate|"
    r"translation|meaning of|definition of|history of|population|country|countries|planet|universe|"
    r"science|physics|chemistry|biology|maths?|mathematics|equation|god|religion|politics|political|"
    r"election|elections|vote|news|horoscope|astrology|zodiac|girlfriend|boyfriend|dating|doctor|"
    r"medicine|disease|symptoms|diet|travel|tourist|who invented|who won|who wrote|who discovered|"
    r"tallest|largest|biggest|fastest|chatgpt|openai|gemini|llama|riddle|puzzle|game|games|"
    r"write (me )?(a|an) (poem|story|essay|song|letter|speech))\b", re.I)

GREETING = re.compile(r"^\s*(hi|hii+|hello|hey|namaste|namaskar|good (morning|afternoon|evening)|thanks|"
                      r"how are you|how r u|kaise ho|who are you|what is your name|what's your name|"
                      r"thank you|thank u|thx|ok|okay|ok thanks|bye|yes|no|haan|nahi|theek hai|shukriya|"
                      r"dhanyavaad)\b[\s!.,?]*$", re.I)

CATEGORY = {"code": "code or programming", "general": "general questions"}


def check(text: str, audience: str = CUSTOMER, model=None) -> dict:
    """{"in_scope", "category", "by", "why"}. `model` is an `llm.LLM`; it is asked only when the words alone
    cannot tell (and only with the tokenised text a model may see)."""
    t = (text or "").strip()
    if not t or GREETING.match(t):
        return {"in_scope": True, "category": "greeting" if t else "empty", "by": "rules", "why": "a greeting"}
    fin = bool(FINANCE.search(t))
    work = audience == STAFF and bool(WORK.search(t))
    if CODE_STRONG.search(t) or (CODE_WORDS.search(t) and not fin):
        return {"in_scope": False, "category": "code", "by": "rules", "why": "asks for code or programming"}
    if GENERAL.search(t) and not fin:
        return {"in_scope": False, "category": "general", "by": "rules", "why": "a general question, not about money"}
    if fin or work:
        return {"in_scope": True, "category": "finance" if fin else "work", "by": "rules",
                "why": "about banking or payments" if fin else "about the desk's own work"}
    if model is not None and getattr(model, "enabled", False):
        got = model.in_scope(t, audience)
        if got is not None:
            return {"in_scope": got, "category": "finance" if got else "other", "by": "model",
                    "why": "the model read it as about banking or payments" if got else
                    "the model read it as not about banking or payments"}
    # neither words nor a model can tell: customers get the desk's own question back ("which payment?"),
    # which is about money anyway; staff get an agent's account of its own work
    return {"in_scope": True, "category": "unclear", "by": "rules", "why": "nothing off-topic in it"}


def answer_ok(text: str | None) -> bool:
    """A model's answer may go out: it has words, is not the OFF_TOPIC signal and holds no code."""
    t = (text or "").strip()
    return bool(t) and OFF not in t and not CODE_STRONG.search(t)


def refusal(audience: str, category: str = "", lang: str = "en") -> str:
    if audience == STAFF:
        what = CATEGORY.get(category, "anything outside banking and payments")
        return ("I only work on banking and payments here: cases, refunds, approvals, routines and the bank's "
                f"systems. I can't help with {what}. Ask me about a payment, a case or my work.")
    if lang == "hinglish":
        return ("Main sirf banking aur payments mein madad kar sakta hoon: UPI, card, refund, account aur "
                "transactions. Kya kisi payment mein madad chahiye?")
    return ("I can only help with banking and payments here: UPI, cards, refunds, your account and "
            "transactions. Is there a payment I can help you with?")
