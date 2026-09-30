import urllib.request
import json
import re

req = urllib.request.Request("https://www.youtube.com/watch?v=zymDUoCcoNY", headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
html = urllib.request.urlopen(req).read().decode("utf-8")

m_desc = re.search(r'"shortDescription":"(.*?)"', html)
if m_desc:
    print("DESC:", m_desc.group(1)[:500])

m_captions = re.search(r'"captionTracks":\s*(\[.*?\])', html)
if m_captions:
    tracks = json.loads(m_captions.group(1))
    print(f"Found {len(tracks)} caption tracks")
    url = tracks[0]["baseUrl"]
    sub_xml = urllib.request.urlopen(url).read().decode("utf-8")
    clean = re.sub(r'<text[^>]*>(.*?)</text>', r'\1 ', sub_xml)
    clean = re.sub(r'<[^>]+>', '', clean)
    clean = clean.replace('&amp;', '&').replace('&#39;', "'").replace('&quot;', '"')
    with open("transcript_trendline.txt", "w") as f:
        f.write(clean)
    print("Transcript saved, length:", len(clean))
    print("Preview:\n", clean[:2000])
else:
    print("No captions found directly in HTML")
