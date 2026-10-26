# 실행 버튼을 표현하는 macOS 앱 아이콘을 생성한다.
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).parent
image = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((40, 40, 984, 984), radius=214, fill='#151c20', outline='#334047', width=5)
draw.rounded_rectangle((218, 250, 806, 774), radius=58, fill='#222d32', outline='#536369', width=9)
for x in (266, 304, 342):
    draw.ellipse((x, 286, x+15, 301), fill='#9eafb4')
draw.line((220, 334, 804, 334), fill='#536369', width=5)
draw.polygon([(426, 423), (426, 678), (635, 550)], fill='#a3efc4')
iconset = root / 'AppIcon.iconset'
iconset.mkdir(exist_ok=True)
for size in (16, 32, 128, 256, 512):
    for scale in (1, 2):
        name = f'icon_{size}x{size}' + ('@2x' if scale == 2 else '') + '.png'
        image.resize((size*scale, size*scale), Image.Resampling.LANCZOS).save(iconset/name)
image.resize((256,256), Image.Resampling.LANCZOS).save(root/'icon.png')

# 메뉴 바용 단색 템플릿 아이콘. 파일 이름이 Template으로 끝나면 macOS가 메뉴 바 색에 맞춰 칠한다.
for scale, suffix in ((1, ''), (2, '@2x')):
    size = 18 * scale
    big = Image.new('RGBA', (size * 8, size * 8), (0, 0, 0, 0))
    pen = ImageDraw.Draw(big)
    unit = scale * 8
    pen.rounded_rectangle((1.5*unit, 2.5*unit, 16.5*unit, 15.5*unit), radius=3*unit, outline='black', width=round(1.6*unit))
    pen.line([(5*unit, 6.5*unit), (8*unit, 9*unit), (5*unit, 11.5*unit)], fill='black', width=round(1.7*unit), joint='curve')
    pen.line([(9.5*unit, 12*unit), (13*unit, 12*unit)], fill='black', width=round(1.7*unit))
    big.resize((size, size), Image.Resampling.LANCZOS).save(root / f'trayTemplate{suffix}.png')
