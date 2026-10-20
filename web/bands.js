// Band plan for the overlay strip and the Bands tab. North America (Canada / US) allocations, 1 kHz - 2 GHz (the
// RSPduo's range). Each band: name, start/stop (Hz), default mode, bandwidth and tuning step, and a tune-to frequency.
// cat groups them in the Bands tab; The antenna follows the frequency (see the server's auto antenna).
const k = 1e3, M = 1e6;
export const CATS = ['Broadcast', 'Shortwave', 'Time & Weather', 'Aviation', 'Marine', 'Amateur', 'Personal radio', 'Land mobile', 'Space & ISM', 'Other'];
export const BANDS = [
  // broadcast
  { cat: 'Broadcast', name: 'LW broadcast', start: 148.5 * k, stop: 283.5 * k, mode: 'am', bw: 9000, step: 9000, tune: 198 * k },
  { cat: 'Broadcast', name: 'MW (AM) broadcast', start: 530 * k, stop: 1700 * k, mode: 'am', bw: 10000, step: 10000, tune: 1000 * k },
  { cat: 'Broadcast', name: 'FM broadcast', start: 87.5 * M, stop: 108 * M, mode: 'wfm', bw: 180000, step: 200000, tune: 101.3 * M },
  { cat: 'Broadcast', name: 'TV VHF-low (ch 2-6)', start: 54 * M, stop: 88 * M, mode: 'wfm', bw: 180000, step: 100000, tune: 59.75 * M },
  { cat: 'Broadcast', name: 'TV VHF-high (ch 7-13)', start: 174 * M, stop: 216 * M, mode: 'wfm', bw: 180000, step: 100000, tune: 177.25 * M },
  { cat: 'Broadcast', name: 'TV UHF (ch 14-36)', start: 470 * M, stop: 608 * M, mode: 'wfm', bw: 180000, step: 100000, tune: 473 * M },
  // shortwave broadcast bands
  ...[[120, 2.3, 2.495], [90, 3.2, 3.4], [75, 3.9, 4.0], [60, 4.75, 5.06], [49, 5.9, 6.2], [41, 7.2, 7.45], [31, 9.4, 9.9], [25, 11.6, 12.1], [22, 13.57, 13.87], [19, 15.1, 15.8], [16, 17.48, 17.9], [15, 18.9, 19.02], [13, 21.45, 21.85], [11, 25.67, 26.1]].map(
    ([m, a, b]) => ({ cat: 'Shortwave', name: `${m} m broadcast`, start: a * M, stop: b * M, mode: 'am', bw: 9000, step: 5000, tune: Math.round(((a + b) / 2) * 200) / 200 * M })),
  // time and weather
  { cat: 'Time & Weather', name: 'CHU Canada 3.330', start: 3.329 * M, stop: 3.331 * M, mode: 'usb', bw: 2700, step: 100, tune: 3.33 * M - 1000, point: true },
  { cat: 'Time & Weather', name: 'CHU Canada 7.850', start: 7.849 * M, stop: 7.851 * M, mode: 'usb', bw: 2700, step: 100, tune: 7.85 * M - 1000, point: true },
  { cat: 'Time & Weather', name: 'CHU Canada 14.670', start: 14.669 * M, stop: 14.671 * M, mode: 'usb', bw: 2700, step: 100, tune: 14.67 * M - 1000, point: true },
  ...[2.5, 5, 10, 15, 20, 25].map((f) => ({ cat: 'Time & Weather', name: `WWV ${f} MHz`, start: f * M - 5000, stop: f * M + 5000, mode: 'am', bw: 6000, step: 1000, tune: f * M, point: true })),
  { cat: 'Time & Weather', name: 'Weatheradio / NOAA WX', start: 162.4 * M, stop: 162.55 * M, mode: 'nfm', bw: 12500, step: 25000, tune: 162.55 * M },
  { cat: 'Time & Weather', name: 'NOAA weather satellites (APT)', start: 137 * M, stop: 138 * M, mode: 'nfm', bw: 40000, step: 5000, tune: 137.1 * M },
  { cat: 'Time & Weather', name: 'Marine weather fax (Halifax CFH)', start: 4.271 * M - 2000, stop: 4.271 * M + 2000, mode: 'usb', bw: 2700, step: 100, tune: 4.271 * M - 1900, point: true },
  // aviation
  { cat: 'Aviation', name: 'Air band (VHF AM)', start: 118 * M, stop: 137 * M, mode: 'am', bw: 8330, step: 25000, tune: 119.2 * M },
  { cat: 'Aviation', name: 'Air guard 121.5', start: 121.495 * M, stop: 121.505 * M, mode: 'am', bw: 8330, step: 25000, tune: 121.5 * M, point: true },
  { cat: 'Aviation', name: 'ACARS 131.55', start: 131.545 * M, stop: 131.555 * M, mode: 'am', bw: 8330, step: 25000, tune: 131.55 * M, point: true },
  { cat: 'Aviation', name: 'Military air (UHF AM)', start: 225 * M, stop: 400 * M, mode: 'am', bw: 8330, step: 25000, tune: 243 * M },
  { cat: 'Aviation', name: 'HF aero (Gander / Shanwick)', start: 2.85 * M, stop: 22 * M, mode: 'usb', bw: 2700, step: 1000, tune: 8.891 * M, overlay: false },
  { cat: 'Aviation', name: 'ADS-B 1090 (spectrum only)', start: 1089 * M, stop: 1091 * M, mode: 'am', bw: 50000, step: 100000, tune: 1090 * M },
  { cat: 'Aviation', name: 'Air navigation (VOR / ILS)', start: 108 * M, stop: 118 * M, mode: 'am', bw: 8330, step: 50000, tune: 113 * M },
  // marine
  { cat: 'Marine', name: 'Marine VHF', start: 156 * M, stop: 162.025 * M, mode: 'nfm', bw: 12500, step: 25000, tune: 156.8 * M },
  { cat: 'Marine', name: 'Ch 16 distress 156.800', start: 156.795 * M, stop: 156.805 * M, mode: 'nfm', bw: 12500, step: 25000, tune: 156.8 * M, point: true },
  { cat: 'Marine', name: 'AIS 161.975 / 162.025', start: 161.96 * M, stop: 162.04 * M, mode: 'nfm', bw: 25000, step: 50000, tune: 161.975 * M },
  { cat: 'Marine', name: 'Marine MF / HF SSB', start: 2 * M, stop: 2.85 * M, mode: 'usb', bw: 2700, step: 1000, tune: 2.182 * M },
  // amateur
  { cat: 'Amateur', name: '160 m', start: 1.8 * M, stop: 2 * M, mode: 'lsb', bw: 2700, step: 500, tune: 1.9 * M },
  { cat: 'Amateur', name: '80 m', start: 3.5 * M, stop: 4 * M, mode: 'lsb', bw: 2700, step: 500, tune: 3.75 * M },
  { cat: 'Amateur', name: '60 m', start: 5.3305 * M, stop: 5.4065 * M, mode: 'usb', bw: 2700, step: 500, tune: 5.357 * M },
  { cat: 'Amateur', name: '40 m', start: 7 * M, stop: 7.3 * M, mode: 'lsb', bw: 2700, step: 500, tune: 7.2 * M },
  { cat: 'Amateur', name: '30 m', start: 10.1 * M, stop: 10.15 * M, mode: 'cw', bw: 500, step: 100, tune: 10.11 * M },
  { cat: 'Amateur', name: '20 m', start: 14 * M, stop: 14.35 * M, mode: 'usb', bw: 2700, step: 500, tune: 14.2 * M },
  { cat: 'Amateur', name: '17 m', start: 18.068 * M, stop: 18.168 * M, mode: 'usb', bw: 2700, step: 500, tune: 18.13 * M },
  { cat: 'Amateur', name: '15 m', start: 21 * M, stop: 21.45 * M, mode: 'usb', bw: 2700, step: 500, tune: 21.3 * M },
  { cat: 'Amateur', name: '12 m', start: 24.89 * M, stop: 24.99 * M, mode: 'usb', bw: 2700, step: 500, tune: 24.95 * M },
  { cat: 'Amateur', name: '10 m', start: 28 * M, stop: 29.7 * M, mode: 'usb', bw: 2700, step: 500, tune: 28.4 * M },
  { cat: 'Amateur', name: '6 m', start: 50 * M, stop: 54 * M, mode: 'usb', bw: 2700, step: 1000, tune: 50.125 * M },
  { cat: 'Amateur', name: '2 m', start: 144 * M, stop: 148 * M, mode: 'nfm', bw: 12500, step: 5000, tune: 146.52 * M },
  { cat: 'Amateur', name: '2 m SSB / CW', start: 144 * M, stop: 144.275 * M, mode: 'usb', bw: 2700, step: 500, tune: 144.2 * M, overlay: false },
  { cat: 'Amateur', name: 'ISS / APRS 145.800 / 144.390', start: 144.385 * M, stop: 145.805 * M, mode: 'nfm', bw: 12500, step: 5000, tune: 145.8 * M, overlay: false },
  { cat: 'Amateur', name: '1.25 m', start: 222 * M, stop: 225 * M, mode: 'nfm', bw: 12500, step: 5000, tune: 223.5 * M },
  { cat: 'Amateur', name: '70 cm', start: 430 * M, stop: 450 * M, mode: 'nfm', bw: 12500, step: 12500, tune: 446 * M },
  { cat: 'Amateur', name: '33 cm', start: 902 * M, stop: 928 * M, mode: 'nfm', bw: 12500, step: 12500, tune: 927.5 * M },
  { cat: 'Amateur', name: '23 cm', start: 1240 * M, stop: 1300 * M, mode: 'nfm', bw: 12500, step: 25000, tune: 1294.5 * M },
  // personal radio
  { cat: 'Personal radio', name: 'CB (AM)', start: 26.965 * M, stop: 27.405 * M, mode: 'am', bw: 8000, step: 10000, tune: 27.185 * M },
  { cat: 'Personal radio', name: 'FRS / GMRS 462', start: 462.5625 * M, stop: 462.725 * M, mode: 'nfm', bw: 12500, step: 12500, tune: 462.5625 * M },
  { cat: 'Personal radio', name: 'FRS 467', start: 467.5625 * M, stop: 467.7125 * M, mode: 'nfm', bw: 12500, step: 12500, tune: 467.5625 * M },
  { cat: 'Personal radio', name: 'MURS', start: 151.82 * M, stop: 154.6 * M, mode: 'nfm', bw: 12500, step: 5000, tune: 151.94 * M, overlay: false },
  { cat: 'Personal radio', name: 'PMR446 (Europe)', start: 446 * M, stop: 446.2 * M, mode: 'nfm', bw: 12500, step: 6250, tune: 446.00625 * M, overlay: false },
  // land mobile
  { cat: 'Land mobile', name: 'VHF land mobile', start: 138 * M, stop: 144 * M, mode: 'nfm', bw: 12500, step: 12500, tune: 141 * M },
  { cat: 'Land mobile', name: 'VHF business / public safety', start: 148 * M, stop: 174 * M, mode: 'nfm', bw: 12500, step: 7500, tune: 155 * M, overlay: false },
  { cat: 'Land mobile', name: 'Railway (AAR / CN / CP)', start: 160.215 * M, stop: 161.565 * M, mode: 'nfm', bw: 12500, step: 15000, tune: 160.935 * M },
  { cat: 'Land mobile', name: 'UHF land mobile', start: 450 * M, stop: 470 * M, mode: 'nfm', bw: 12500, step: 12500, tune: 460 * M },
  { cat: 'Land mobile', name: '700 / 800 MHz trunking (mostly P25)', start: 764 * M, stop: 869 * M, mode: 'nfm', bw: 12500, step: 12500, tune: 851 * M },
  { cat: 'Land mobile', name: 'Pagers 929-932', start: 929 * M, stop: 932 * M, mode: 'nfm', bw: 12500, step: 12500, tune: 929.6125 * M },
  // space & ISM
  { cat: 'Space & ISM', name: 'ISM 433.92 (sensors, remotes)', start: 433.05 * M, stop: 434.79 * M, mode: 'am', bw: 50000, step: 10000, tune: 433.92 * M },
  { cat: 'Space & ISM', name: 'ISM 915 (LoRa, meters)', start: 902 * M, stop: 928 * M, mode: 'nfm', bw: 50000, step: 25000, tune: 915 * M, overlay: false },
  { cat: 'Space & ISM', name: 'Hydrogen line 1420.405', start: 1420 * M, stop: 1420.81 * M, mode: 'usb', bw: 2700, step: 1000, tune: 1420.405 * M },
  { cat: 'Space & ISM', name: 'Inmarsat 1.5 GHz', start: 1525 * M, stop: 1559 * M, mode: 'usb', bw: 2700, step: 1000, tune: 1545 * M },
  { cat: 'Space & ISM', name: 'GPS L1 (spectrum only)', start: 1574.4 * M, stop: 1576.4 * M, mode: 'usb', bw: 2700, step: 1000, tune: 1575.42 * M },
  { cat: 'Space & ISM', name: 'Iridium', start: 1616 * M, stop: 1626.5 * M, mode: 'usb', bw: 2700, step: 1000, tune: 1621 * M },
  { cat: 'Space & ISM', name: 'GOES / weather sats L-band', start: 1680 * M, stop: 1695 * M, mode: 'usb', bw: 2700, step: 1000, tune: 1694.1 * M },
  { cat: 'Other', name: 'VLF / LF (time, beacons)', start: 1 * k, stop: 148.5 * k, mode: 'usb', bw: 2700, step: 100, tune: 60 * k },
  { cat: 'Other', name: 'NDB beacons', start: 190 * k, stop: 535 * k, mode: 'cw', bw: 500, step: 1000, tune: 344 * k, overlay: false },
];
export const COLORS = {
  Broadcast: '#4fc3f7', Shortwave: '#29b6f6', 'Time & Weather': '#ffd54f', Aviation: '#ba68c8', Marine: '#4db6ac',
  Amateur: '#81c784', 'Personal radio': '#ffb74d', 'Land mobile': '#90a4ae', 'Space & ISM': '#f06292', Other: '#a1887f',
};
// Quick ranges for the Search / Scan forms.
export const SCAN_PRESETS = [
  { name: 'Air band', start: 118e6, stop: 137e6, step: 25000, mode: 'am' },
  { name: 'Marine VHF', start: 156e6, stop: 162.025e6, step: 25000, mode: 'nfm' },
  { name: 'Weather', start: 162.4e6, stop: 162.55e6, step: 25000, mode: 'nfm' },
  { name: '2 m FM', start: 144e6, stop: 148e6, step: 5000, mode: 'nfm' },
  { name: '70 cm FM', start: 430e6, stop: 450e6, step: 12500, mode: 'nfm' },
  { name: 'FRS / GMRS', start: 462.55e6, stop: 467.725e6, step: 12500, mode: 'nfm' },
  { name: 'Railway', start: 160.2e6, stop: 161.6e6, step: 15000, mode: 'nfm' },
  { name: 'VHF land mobile', start: 148e6, stop: 174e6, step: 12500, mode: 'nfm' },
  { name: 'UHF land mobile', start: 450e6, stop: 470e6, step: 12500, mode: 'nfm' },
  { name: 'CB', start: 26.965e6, stop: 27.405e6, step: 10000, mode: 'am' },
  { name: 'MW broadcast', start: 530e3, stop: 1700e3, step: 10000, mode: 'am' },
  { name: 'Shortwave 2-30 MHz', start: 2e6, stop: 30e6, step: 5000, mode: 'am' },
  { name: 'Whole range 1 kHz - 2 GHz', start: 1e3, stop: 2000e6, step: 25000, mode: 'nfm' },
];
// RBDS (North America) and RDS (Europe) programme types.
export const PTY_RBDS = ['None', 'News', 'Information', 'Sports', 'Talk', 'Rock', 'Classic Rock', 'Adult Hits', 'Soft Rock', 'Top 40', 'Country', 'Oldies', 'Soft', 'Nostalgia', 'Jazz', 'Classical', 'Rhythm and Blues', 'Soft R&B', 'Language', 'Religious Music', 'Religious Talk', 'Personality', 'Public', 'College', 'Spanish Talk', 'Spanish Music', 'Hip Hop', '', '', 'Weather', 'Emergency Test', 'Emergency'];
export const PTY_RDS = ['None', 'News', 'Current Affairs', 'Information', 'Sport', 'Education', 'Drama', 'Culture', 'Science', 'Varied', 'Pop Music', 'Rock Music', 'Easy Listening', 'Light Classical', 'Serious Classical', 'Other Music', 'Weather', 'Finance', "Children's", 'Social Affairs', 'Religion', 'Phone-in', 'Travel', 'Leisure', 'Jazz', 'Country', 'National Music', 'Oldies', 'Folk', 'Documentary', 'Alarm Test', 'Alarm'];
// US call letters from an RBDS PI code (K/W stations); Canadian and other PI codes have none.
export function callsign(pi) {
  if (pi == null || pi < 0) return '';
  if (pi >= 0x1000 && pi <= 0x994f) {
    const w = pi >= 0x54a8, n = pi - (w ? 0x54a8 : 0x1000);
    const L = (x) => String.fromCharCode(65 + x);
    return (w ? 'W' : 'K') + L(Math.floor(n / 676)) + L(Math.floor((n % 676) / 26)) + L(n % 26);
  }
  if ((pi & 0xf000) === 0xc000) return 'Canada';
  return '';
}
