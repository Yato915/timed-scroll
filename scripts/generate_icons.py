"""Generate the toolbox toolbar icons without third-party packages."""

import struct
import zlib
from pathlib import Path


def inside_round_rect(x, y, left, top, right, bottom, radius):
    inner_left = left + radius
    inner_top = top + radius
    inner_right = right - radius
    inner_bottom = bottom - radius
    dx = 0 if inner_left <= x <= inner_right else min(abs(x - inner_left), abs(x - inner_right))
    dy = 0 if inner_top <= y <= inner_bottom else min(abs(y - inner_top), abs(y - inner_bottom))
    return dx * dx + dy * dy <= radius * radius


def arrow_hit(x, y, size):
    center_x = size * 0.5
    shaft_half = size * 0.045
    if abs(x - center_x) <= shaft_half and size * 0.30 <= y <= size * 0.50:
        return True
    head_top = size * 0.46
    head_bottom = size * 0.64
    if y < head_top or y > head_bottom:
        return False
    progress = (y - head_top) / (head_bottom - head_top)
    return abs(x - center_x) <= size * 0.155 * (1 - progress)


def sample(x, y, size):
    padding = size * 0.08
    if not inside_round_rect(x, y, padding, padding, size - padding, size - padding, size * 0.22):
        return (0, 0, 0, 0)

    color = (36, 32, 29, 255)
    center_x = size * 0.5
    center_y = size * 0.48
    disc_radius = size * 0.27
    if (x - center_x) ** 2 + (y - center_y) ** 2 <= disc_radius ** 2:
        color = (230, 162, 60, 255)
        if arrow_hit(x, y, size):
            color = (36, 32, 29, 255)
    return color


def pixel(x, y, size):
    sample_count = 4
    red_sum = green_sum = blue_sum = alpha_sum = 0
    for sample_y in range(sample_count):
        for sample_x in range(sample_count):
            red, green, blue, alpha = sample(
                x + (sample_x + 0.5) / sample_count,
                y + (sample_y + 0.5) / sample_count,
                size,
            )
            alpha_sum += alpha
            red_sum += red * alpha
            green_sum += green * alpha
            blue_sum += blue * alpha
    if alpha_sum == 0:
        return (0, 0, 0, 0)
    return (
        round(red_sum / alpha_sum),
        round(green_sum / alpha_sum),
        round(blue_sum / alpha_sum),
        round(alpha_sum / (sample_count * sample_count)),
    )


def png_chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def build_png(size):
    raw_rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            row.extend(pixel(x, y, size))
        raw_rows.append(bytes(row))
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    compressed = zlib.compress(b"".join(raw_rows), 9)
    return b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", header) + png_chunk(b"IDAT", compressed) + png_chunk(b"IEND", b"")


def main():
    icon_directory = Path(__file__).resolve().parents[1] / "icons"
    icon_directory.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        (icon_directory / f"icon{size}.png").write_bytes(build_png(size))


if __name__ == "__main__":
    main()
