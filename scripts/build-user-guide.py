#!/usr/bin/env python3
"""Build the printable guide from docs/user-guide.md (requires ReportLab).

python3 scripts/build-user-guide.py
Pictures are committed; refresh them with node scripts/capture-user-guide.mjs
after npm run build, using Playwright Chromium or CHROMIUM_EXECUTABLE_PATH.
"""
from pathlib import Path
from html import escape
import re

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image, Table, TableStyle, PageBreak, KeepTogether

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'docs/user-guide.md'
OUTPUT = ROOT / 'output/pdf/classroom-handoff-user-guide.pdf'
RED = colors.HexColor('#B71C1C')
INK = colors.HexColor('#171717')
MUTED = colors.HexColor('#52525B')
RULE = colors.HexColor('#D4D4D8')
PALE = colors.HexColor('#F4F4F5')
WIDTH = 504
FONT, BOLD = 'Helvetica', 'Helvetica-Bold'
font_root = Path('/System/Library/Fonts/Supplemental')
if (font_root / 'Arial.ttf').exists():
    FONT, BOLD = 'GuideSans', 'GuideSans-Bold'
    pdfmetrics.registerFont(TTFont(FONT, str(font_root / 'Arial.ttf')))
    pdfmetrics.registerFont(TTFont(BOLD, str(font_root / 'Arial Bold.ttf')))
    pdfmetrics.registerFontFamily(FONT, normal=FONT, bold=BOLD)

styles = {
    'body': ParagraphStyle('Body', fontName=FONT, fontSize=11, leading=14.5, textColor=INK, spaceAfter=6),
    'title': ParagraphStyle('Title', fontName=BOLD, fontSize=25, leading=29, textColor=INK, spaceAfter=14),
    'heading': ParagraphStyle('Heading', fontName=BOLD, fontSize=13, leading=17, textColor=INK, spaceBefore=6, spaceAfter=4, keepWithNext=True),
    'list': ParagraphStyle('List', fontName=FONT, fontSize=11, leading=14.5, textColor=INK, leftIndent=16, firstLineIndent=-16, spaceAfter=5),
    'note': ParagraphStyle('Note', fontName=FONT, fontSize=10.5, leading=14, textColor=INK),
    'caption': ParagraphStyle('Caption', fontName=FONT, fontSize=9, leading=12, textColor=MUTED, spaceBefore=5, spaceAfter=6),
}


def markup(text):
    references = {'#1-send-your-lesson': 1, '#2-first-time-connect-and-pair-once': 2, '#3-no-suggestion-pair-with-a-code': 3}
    text = re.sub(r'\[([^\]]+)\]\((#[^)]+)\)', lambda match: f'{match[1]} (page {references[match[2]]})', escape(text))
    return re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)


def picture(line, width=WIDTH):
    match = re.fullmatch(r'!\[(.*?)\]\((.*?)\)', line)
    alt, relative = match.groups()
    if 'user-guide-code' in relative:
        width = min(width, 400)
    image = Image(str(SOURCE.parent / relative))
    scale = width / image.imageWidth
    image.drawWidth = width
    image.drawHeight = image.imageHeight * scale
    return [image, Paragraph(markup(alt), styles['caption'])]


def blocks(text, width=WIDTH):
    result = []
    lines = text.strip().splitlines()
    index = 0
    while index < len(lines):
        line = lines[index].strip()
        index += 1
        if not line or line.startswith('# Classroom'):
            continue
        if line == '---':
            break  # The Markdown colophon is already in the PDF footer.
        if line == '<!-- pdf:columns -->':
            column_lines = []
            while lines[index].strip() != '<!-- pdf:endcolumns -->':
                column_lines.append(lines[index])
                index += 1
            index += 1
            image_at = next(i for i, value in enumerate(column_lines) if value.strip().startswith('!['))
            left = blocks('\n'.join(column_lines[:image_at]), 286)
            right = picture(column_lines[image_at].strip(), 200)
            columns = Table([[left, '', right]], colWidths=[286, 18, 200], hAlign='LEFT')
            columns.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0), ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0)]))
            result.extend([columns, Spacer(1, 8)])
        elif line.startswith('## '):
            result.append(Paragraph(markup(line[3:]), styles['title']))
        elif line.startswith('### '):
            result.append(Paragraph(markup(line[4:]), styles['heading']))
        elif line.startswith('!['):
            result.extend(picture(line, width))
        elif line.startswith('> '):
            note = Table([[Paragraph(markup(line[2:]), styles['note'])]], colWidths=[width], hAlign='LEFT')
            note.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), PALE), ('LINEBEFORE', (0, 0), (0, 0), 3, RED), ('LEFTPADDING', (0, 0), (-1, -1), 12), ('RIGHTPADDING', (0, 0), (-1, -1), 12), ('TOPPADDING', (0, 0), (-1, -1), 9), ('BOTTOMPADDING', (0, 0), (-1, -1), 9)]))
            result.extend([KeepTogether([Spacer(1, 4), note, Spacer(1, 8)])])
        elif re.match(r'^\d+\. ', line):
            result.append(Paragraph(markup(line), styles['list']))
        elif line.startswith('- '):
            result.append(Paragraph('&#8226;  ' + markup(line[2:]), styles['list']))
        elif not line.startswith('<!--'):
            result.append(Paragraph(markup(line), styles['body']))
    return result


def chrome(canvas, doc):
    canvas.saveState()
    canvas.drawImage(str(ROOT / 'extension/icons/icon-128.png'), 54, 735, width=26, height=26, mask='auto')
    canvas.setFillColor(INK)
    canvas.setFont(BOLD, 12)
    canvas.drawString(89, 744, 'Classroom Handoff')
    canvas.setFillColor(MUTED)
    canvas.setFont(FONT, 9)
    canvas.drawRightString(558, 744, 'NEW USER GUIDE')
    canvas.setStrokeColor(RULE)
    canvas.line(54, 722, 558, 722)
    canvas.line(54, 48, 558, 48)
    canvas.setFont(FONT, 8.5)
    canvas.drawString(54, 33, 'Version 0.2.4  |  Updated November 14, 2026')
    canvas.drawRightString(558, 33, f'{doc.page} / 4')
    canvas.restoreState()


def main():
    text = SOURCE.read_text()
    sections = text.split('<!-- pdf:page -->')
    assert len(sections) == 4
    story = []
    for index, section in enumerate(sections):
        if index:
            story.append(PageBreak())
        story.extend(blocks(section))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    document = SimpleDocTemplate(str(OUTPUT), pagesize=letter, leftMargin=48, rightMargin=48, topMargin=80, bottomMargin=58, title='Classroom Handoff - New User Guide', author='CyganTech', subject='Easy steps for pairing browsers and sending lesson tabs', pageCompression=1)
    document.build(story, onFirstPage=chrome, onLaterPages=chrome)
    if document.page != 4:
        raise RuntimeError(f'Guide overflowed to {document.page} pages; adjust the layout before sharing.')
    print(f'Built {OUTPUT} (4 pages)')


if __name__ == '__main__':
    main()
