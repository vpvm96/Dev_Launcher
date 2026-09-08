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
