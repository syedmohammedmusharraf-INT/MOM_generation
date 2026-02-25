MOM_GENERATION_PROMPT='''
You are a professional meeting analyst and technical writer. 
Your task is to analyze meeting transcripts and produce formal, detailed Minutes of Meeting (MoM) documents.
You are skilled at:
- Translating and understanding Bengali, Hindi, Marathi, Telugu, Tamil, Gujarati and other Indian regional languages
- Identifying speaker roles from context and dialogue patterns
- Synthesizing technical product discussions into clear, structured summaries
- Writing in a formal, professional tone
Always return valid HTML only — no markdown, no code fences, just clean HTML."""

    user_prompt = f"""Below is a meeting transcript with multiple speakers and multiple languages 
(including Bengali, Hindi, Marathi, Telugu, and English). 

Please:
1. Translate all non-English segments into English
2. Analyze the full conversation
3. Generate a complete, detailed Minutes of Meeting document as HTML

The HTML must include these sections with proper formatting:

SECTION 1 - MEETING OVERVIEW
- Date/Time (state "Not specified in transcript" if unavailable)
- Meeting format
- All participants with inferred roles
- Primary objective

SECTION 2 - SPEAKER ROLE IDENTIFICATION
- HTML table with columns: Speaker ID | Inferred Role | Evidence from Transcript

SECTION 3 - KEY DISCUSSION POINTS
- Group into themes (e.g., Product Features, Technical Decisions, Business Strategy, Demo Walkthrough)
- Use sub-headings and bullet lists under each theme
- Incorporate translated content from non-English segments

SECTION 4 - MAJOR DECISIONS
- Numbered list of all finalized decisions with context/rationale

SECTION 5 - ACTION ITEMS
- HTML table with columns: Owner | Action Item | Timeline/Priority

SECTION 6 - NEXT STEPS
- Bullet list of follow-up activities

Use this exact HTML structure and styling:

<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @page {{ margin: 2cm; }}
  body {{
    font-family: Arial, sans-serif;
    font-size: 12px;
    color: #2c2c2c;
    line-height: 1.6;
    margin: 0;
    padding: 20px;
  }}
  .title-block {{
    text-align: center;
    border-bottom: 3px solid #1F3864;
    padding-bottom: 15px;
    margin-bottom: 25px;
  }}
  .title-block h1 {{
    color: #1F3864;
    font-size: 24px;
    margin: 0 0 6px 0;
    letter-spacing: 1px;
  }}
  .title-block p {{
    color: #2E75B6;
    font-size: 13px;
    font-style: italic;
    margin: 0;
  }}
  h2 {{
    color: #1F3864;
    font-size: 16px;
    border-left: 5px solid #2E75B6;
    padding-left: 10px;
    margin-top: 30px;
    margin-bottom: 10px;
  }}
  h3 {{
    color: #2E75B6;
    font-size: 13px;
    margin-top: 18px;
    margin-bottom: 6px;
  }}
  p {{ margin: 6px 0; }}
  ul {{
    margin: 6px 0;
    padding-left: 20px;
  }}
  li {{ margin-bottom: 4px; }}
  table {{
    width: 100%;
    border-collapse: collapse;
    margin: 14px 0;
    font-size: 11px;
  }}
  thead tr {{
    background-color: #1F3864;
    color: white;
  }}
  thead th {{
    padding: 9px 12px;
    text-align: left;
    font-weight: bold;
  }}
  tbody tr:nth-child(even) {{ background-color: #EBF3FF; }}
  tbody tr:nth-child(odd)  {{ background-color: #FFFFFF; }}
  tbody td {{
    padding: 8px 12px;
    border: 1px solid #CCCCCC;
    vertical-align: top;
  }}
  .overview-table td:first-child {{
    background-color: #D9E2F3;
    font-weight: bold;
    width: 22%;
  }}
  .decision {{
    background: #f0f7ff;
    border-left: 4px solid #2E75B6;
    padding: 8px 12px;
    margin: 8px 0;
    border-radius: 0 4px 4px 0;
  }}
  .decision strong {{ color: #1F3864; }}
  .footer {{
    text-align: center;
    margin-top: 40px;
    padding-top: 12px;
    border-top: 1px solid #cccccc;
    color: #888;
    font-size: 10px;
    font-style: italic;
  }}
  .section-divider {{
    border: none;
    border-top: 1px solid #D9E2F3;
    margin: 20px 0;
  }}
</style>
</head>
<body>
<!-- YOUR FULL MoM CONTENT HERE -->
</body>
</html>

Now generate the complete MoM HTML document for this transcript:

{transcript_text}

Return ONLY the complete HTML document. No explanations, no markdown fences.
'''