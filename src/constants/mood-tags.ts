/**
 * Mood Tag Taxonomy for SeedLight
 *
 * Three-layer architecture:
 *   UI buttons (6) → MOOD_MAPPING → fine-grained tags (85+)
 *
 * Tags are organized into three categories:
 *   - Emotions: how the user feels
 *   - Life situations: what the user is going through
 *   - Spiritual themes: what the scripture addresses
 */

// ---------------------------------------------------------------------------
// Emotion tags (~30)
// ---------------------------------------------------------------------------
export const EMOTION_TAGS = [
  "anxious",
  "grateful",
  "confused",
  "joyful",
  "lonely",
  "exhausted",
  "angry",
  "fearful",
  "sorrowful",
  "hopeful",
  "guilty",
  "peaceful",
  "disappointed",
  "overwhelmed",
  "insecure",
  "grieving",
  "ashamed",
  "bitter",
  "content",
  "desperate",
  "doubtful",
  "frustrated",
  "heartbroken",
  "humble",
  "regretful",
  "resentful",
  "tender",
  "yearning",
  "jealous",
  "proud",
] as const;

// ---------------------------------------------------------------------------
// Life situation tags (~25)
// ---------------------------------------------------------------------------
export const SITUATION_TAGS = [
  "work_stress",
  "relationship",
  "family",
  "health",
  "financial",
  "decision",
  "loss",
  "temptation",
  "waiting",
  "new_beginning",
  "failure",
  "success",
  "marriage",
  "parenting",
  "aging",
  "death",
  "sickness",
  "betrayal",
  "injustice",
  "persecution",
  "conflict",
  "addiction",
  "transition",
  "leadership",
  "suffering",
] as const;

// ---------------------------------------------------------------------------
// Spiritual theme tags (~30)
// ---------------------------------------------------------------------------
export const THEME_TAGS = [
  "faith",
  "prayer",
  "forgiveness",
  "love",
  "wisdom",
  "obedience",
  "trust",
  "repentance",
  "salvation",
  "grace",
  "worship",
  "service",
  "patience",
  "courage",
  "humility",
  "purpose",
  "identity",
  "holy_spirit",
  "spiritual_warfare",
  "discipleship",
  "stewardship",
  "creation",
  "sovereignty",
  "justice",
  "mercy",
  "redemption",
  "covenant",
  "sacrifice",
  "holiness",
  "freedom",
  "restoration",
] as const;

// All valid tags combined
export const ALL_TAGS = [
  ...EMOTION_TAGS,
  ...SITUATION_TAGS,
  ...THEME_TAGS,
] as const;

export type MoodTag = (typeof ALL_TAGS)[number];

// ---------------------------------------------------------------------------
// UI Mood → Tag Mapping
// Maps each frontend mood button to a broad set of fine-grained tags.
// When a user selects "焦虑", we query passages tagged with ANY of these.
// ---------------------------------------------------------------------------
export const MOOD_MAPPING: Record<string, readonly string[]> = {
  anxious: [
    "anxious", "worried", "overwhelmed", "insecure", "fearful",
    "stressed", "uncertain", "desperate", "doubtful",
    "work_stress", "financial", "health", "waiting",
    "trust", "faith", "prayer", "peace", "sovereignty",
  ],
  grateful: [
    "grateful", "content", "joyful", "peaceful",
    "humble", "tender", "hopeful",
    "success", "new_beginning",
    "worship", "grace", "salvation", "stewardship", "creation",
  ],
  confused: [
    "confused", "doubtful", "insecure",
    "decision", "transition",
    "wisdom", "purpose", "identity", "faith", "trust",
    "sovereignty", "patience",
  ],
  joyful: [
    "joyful", "grateful", "hopeful", "peaceful", "content",
    "tender",
    "success", "new_beginning",
    "worship", "grace", "love", "creation", "freedom",
  ],
  lonely: [
    "lonely", "grieving", "insecure", "heartbroken", "yearning",
    "sorrowful",
    "loss", "relationship", "betrayal",
    "love", "mercy", "restoration", "identity", "covenant",
  ],
  exhausted: [
    "exhausted", "overwhelmed", "frustrated", "bitter",
    "disappointed",
    "work_stress", "suffering",
    "patience", "restoration", "grace", "trust",
    "sovereignty", "courage",
  ],
  sad: [
    "sorrowful", "grieving", "heartbroken", "disappointed",
    "lonely", "bitter",
    "loss", "suffering",
    "mercy", "restoration", "love", "patience", "covenant",
  ],
  overwhelmed: [
    "overwhelmed", "exhausted", "desperate", "anxious",
    "frustrated",
    "work_stress", "suffering", "health",
    "trust", "sovereignty", "patience", "grace", "prayer",
  ],
  peaceful: [
    "peaceful", "content", "grateful", "hopeful",
    "tender", "humble",
    "worship", "trust", "grace", "creation", "freedom",
    "sovereignty",
  ],
  angry: [
    "angry", "frustrated", "resentful", "bitter",
    "injustice", "betrayal", "conflict",
    "forgiveness", "patience", "justice", "mercy",
    "repentance", "love",
  ],
  fearful: [
    "fearful", "anxious", "insecure", "desperate",
    "doubtful",
    "health", "death", "persecution", "spiritual_warfare",
    "trust", "faith", "courage", "sovereignty", "prayer",
  ],
  guilty: [
    "guilty", "ashamed", "regretful",
    "temptation", "failure",
    "forgiveness", "repentance", "grace", "mercy",
    "redemption", "salvation", "freedom",
  ],
  hopeful: [
    "hopeful", "joyful", "grateful", "peaceful",
    "yearning",
    "new_beginning", "waiting",
    "faith", "trust", "salvation", "redemption",
    "restoration", "purpose",
  ],
  doubtful: [
    "doubtful", "confused", "insecure",
    "frustrated",
    "decision", "spiritual_warfare",
    "faith", "trust", "wisdom", "sovereignty",
    "identity", "purpose",
  ],
  grieving: [
    "grieving", "sorrowful", "heartbroken", "lonely",
    "desperate", "yearning",
    "loss", "death", "suffering",
    "mercy", "love", "restoration", "covenant",
    "patience", "redemption",
  ],
};

// ---------------------------------------------------------------------------
// Tag descriptions (for AI prompts during tagging)
// ---------------------------------------------------------------------------
export const TAG_TAXONOMY_PROMPT = `可用标签分为三类:

**情绪标签 (emotions)**:
anxious(焦虑), grateful(感恩), confused(迷茫), joyful(喜乐), lonely(孤独), exhausted(疲惫),
angry(愤怒), fearful(恐惧), sorrowful(悲伤), hopeful(盼望), guilty(愧疚), peaceful(平安),
disappointed(失望), overwhelmed(不堪重负), insecure(不安), grieving(哀伤), ashamed(羞愧),
bitter(苦毒), content(知足), desperate(绝望), doubtful(疑惑), frustrated(沮丧),
heartbroken(心碎), humble(谦卑), regretful(懊悔), resentful(怨恨), tender(温柔),
yearning(渴慕), jealous(嫉妒), proud(骄傲)

**处境标签 (situations)**:
work_stress(工作压力), relationship(人际关系), family(家庭), health(健康), financial(经济),
decision(抉择), loss(失去), temptation(试探), waiting(等待), new_beginning(新开始),
failure(失败), success(成功), marriage(婚姻), parenting(育儿), aging(年老), death(死亡),
sickness(疾病), betrayal(背叛), injustice(不公), persecution(逼迫), conflict(冲突),
addiction(成瘾), transition(转变), leadership(领导), suffering(受苦)

**灵性标签 (themes)**:
faith(信心), prayer(祷告), forgiveness(饶恕), love(爱), wisdom(智慧), obedience(顺服),
trust(信靠), repentance(悔改), salvation(救恩), grace(恩典), worship(敬拜), service(服事),
patience(忍耐), courage(勇气), humility(谦卑), purpose(目标), identity(身份),
holy_spirit(圣灵), spiritual_warfare(属灵争战), discipleship(门训), stewardship(管家),
creation(创造), sovereignty(主权), justice(公义), mercy(怜悯), redemption(救赎),
covenant(圣约), sacrifice(牺牲), holiness(圣洁), freedom(自由), restoration(修复)`;
