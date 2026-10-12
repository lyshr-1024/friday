use std::f32::consts::{PI, TAU};

use tauri::image::Image;

/// 18pt 的图按 2 倍像素画，macOS 会按高度 18pt 缩放显示
const PX: u32 = 36;
const SCALE: f32 = PX as f32 / 18.0;
const SS: u32 = 4;

const RING_IN: f32 = 6.3;
const RING_OUT: f32 = 8.1;
const SEG: f32 = TAU / 7.0;
const GAP_HALF: f32 = 0.6 / 7.2;
// (x, y, w, h, 圆角)，单位 pt
const F_BARS: [(f32, f32, f32, f32, f32); 3] = [(6.7, 5.5, 1.7, 7.0, 0.85), (6.7, 5.5, 4.9, 1.7, 0.85), (6.7, 8.5, 3.5, 1.5, 0.75)];

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Frame {
    Idle,
    /// 第几格亮青色
    Working(usize),
    Waiting,
    /// F 亮着还是暗下去（闪）
    Asking(bool),
}

type Rgba = [f32; 4];

fn hex(rgb: u32, a: f32) -> Rgba {
    [((rgb >> 16) & 0xff) as f32, ((rgb >> 8) & 0xff) as f32, (rgb & 0xff) as f32, a]
}

/// 空闲是模板图（只用 alpha，系统按菜单栏深浅上色），其余三种是彩图，深浅要自己换色
pub fn render(frame: Frame, dark: bool) -> (Image<'static>, bool) {
    let fg = |a: f32| if dark { hex(0xffffff, a * 0.9) } else { hex(0x000000, a * 0.85) };
    let pick = |light: u32, dark_c: u32| hex(if dark { dark_c } else { light }, 1.0);
    let (segs, f, template): ([Rgba; 7], Rgba, bool) = match frame {
        Frame::Idle => {
            let mut s = [hex(0, 0.35); 7];
            s[4] = hex(0, 1.0);
            (s, hex(0, 1.0), true)
        }
        Frame::Working(k) => {
            let mut s = [fg(0.35); 7];
            s[k % 7] = pick(0x0a8fc2, 0x38d6ff);
            (s, fg(1.0), false)
        }
        Frame::Waiting => ([pick(0xb87100, 0xffb224); 7], fg(1.0), false),
        Frame::Asking(on) => ([pick(0xd93036, 0xff6369); 7], fg(if on { 1.0 } else { 0.15 }), false),
    };
    (paint(|x, y| if let Some(i) = segment(x, y) { Some(segs[i]) } else if in_f(x, y) { Some(f) } else { None }), template)
}

/// 菜单里每行前面的色点
pub fn dot(rgb: u32) -> Image<'static> {
    let c = hex(rgb, 1.0);
    paint(|x, y| ((x - 9.0).powi(2) + (y - 9.0).powi(2) <= 16.0).then_some(c))
}

fn paint(shade: impl Fn(f32, f32) -> Option<Rgba>) -> Image<'static> {
    let mut out = Vec::with_capacity((PX * PX * 4) as usize);
    for py in 0..PX {
        for px in 0..PX {
            let mut acc = [0f32; 4];
            for sy in 0..SS {
                for sx in 0..SS {
                    let x = (px as f32 + (sx as f32 + 0.5) / SS as f32) / SCALE;
                    let y = (py as f32 + (sy as f32 + 0.5) / SS as f32) / SCALE;
                    if let Some(c) = shade(x, y) {
                        for ch in 0..3 {
                            acc[ch] += c[ch] * c[3];
                        }
                        acc[3] += c[3];
                    }
                }
            }
            let n = (SS * SS) as f32;
            let a = acc[3] / n;
            let rgb = |ch: usize| if acc[3] > 0.0 { (acc[ch] / acc[3]).round() as u8 } else { 0 };
            out.extend_from_slice(&[rgb(0), rgb(1), rgb(2), (a * 255.0).round() as u8]);
        }
    }
    Image::new_owned(out, PX, PX)
}

/// 从正上方顺时针数第几格，落在格间缝里或圈外返回 None
fn segment(x: f32, y: f32) -> Option<usize> {
    let (dx, dy) = (x - 9.0, y - 9.0);
    let d = (dx * dx + dy * dy).sqrt();
    if !(RING_IN..=RING_OUT).contains(&d) {
        return None;
    }
    let a = (dy.atan2(dx) + PI / 2.0).rem_euclid(TAU);
    let i = (a / SEG) as usize;
    let local = a - i as f32 * SEG;
    (local >= GAP_HALF && local <= SEG - GAP_HALF).then_some(i.min(6))
}

fn in_f(x: f32, y: f32) -> bool {
    F_BARS.iter().any(|&(rx, ry, w, h, r)| {
        let dx = (rx + r - x).max(x - (rx + w - r)).max(0.0);
        let dy = (ry + r - y).max(y - (ry + h - r)).max(0.0);
        x >= rx && x <= rx + w && y >= ry && y <= ry + h && dx * dx + dy * dy <= r * r
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_go_clockwise_from_top() {
        assert_eq!(segment(10.5, 1.8), Some(0));
        assert_eq!(segment(16.2, 9.0), Some(1));
        assert_eq!(segment(9.0, 1.8), None);
        assert_eq!(segment(9.0, 9.0), None);
    }

    #[test]
    fn f_sits_inside_the_ring() {
        assert!(in_f(7.5, 9.0));
        assert!(in_f(11.0, 6.3));
        assert!(!in_f(11.0, 11.5));
        assert!(segment(7.5, 9.0).is_none());
    }
}
