#include "grid_store.h"
#include <algorithm>
#include <cstring>

namespace {
// Packed scrollback row: a uint16 run count, then per run a uint16 start column
// and the raw CellAttrs, then one entry per cell that is not a continuation:
// kWide before a wide cell, kBlank for a blank cell, otherwise the cluster's
// codepoints in UTF-8 with kJoin before every codepoint after the first. The
// three markers are bytes UTF-8 never uses.
const unsigned char kBlank = 0xFD, kWide = 0xFE, kJoin = 0xFF;

void putUtf8(std::string& out, uint32_t cp) {
  if (cp < 0x80) out += (char)cp;
  else if (cp < 0x800) { out += (char)(0xC0 | (cp >> 6)); out += (char)(0x80 | (cp & 0x3F)); }
  else if (cp < 0x10000) {
    out += (char)(0xE0 | (cp >> 12)); out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F));
  } else {
    out += (char)(0xF0 | ((cp >> 18) & 0x07)); out += (char)(0x80 | ((cp >> 12) & 0x3F));
    out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F));
  }
}

uint32_t getUtf8(const std::string& s, size_t& i) {
  unsigned char c = (unsigned char)s[i++];
  int more = c >= 0xF0 ? 3 : c >= 0xE0 ? 2 : c >= 0xC0 ? 1 : 0;
  uint32_t cp = more == 3 ? (c & 0x07) : more == 2 ? (c & 0x0F) : more == 1 ? (c & 0x1F) : c;
  for (int k = 0; k < more && i < s.size(); k++) cp = (cp << 6) | ((unsigned char)s[i++] & 0x3F);
  return cp;
}

bool blankCell(const Cell& c) {
  return c.nchars == 0 && c.width != 0 && c.a.bg == kColorDefault && !c.a.reverse && !c.a.underline && !c.a.strike;
}
}  // namespace

void GridStore::setSize(int cols, int rows) {
  cols_ = std::max(1, cols);
  rows_ = std::max(1, rows);
  screen_.resize((size_t)rows_);
  for (Row& r : screen_) r.cells.resize((size_t)cols_);
}

Row& GridStore::screenRow(int r) { return screen_[(size_t)r]; }

const Row& GridStore::row(long absRow) const {
  if (absRow >= 0) return absRow < (long)screen_.size() ? screen_[(size_t)absRow] : empty_;
  long idx = (long)sb_.size() + absRow;
  if (idx < 0) return empty_;
  uint64_t serial = firstSerial_ + (uint64_t)idx;
  if (decoded_.empty()) decoded_.resize(kDecodeSlots);
  for (Slot& s : decoded_)
    if (s.serial == serial) return s.row;
  Slot& s = decoded_[nextSlot_];
  nextSlot_ = (nextSlot_ + 1) % decoded_.size();
  s.serial = serial;
  s.row = unpack(sb_[(size_t)idx]);
  return s.row;
}

int GridStore::chars(const Cell& c, uint32_t* out, int max) const {
  if (c.nchars <= 2) {
    int n = std::min<int>(c.nchars, max);
    for (int i = 0; i < n; i++) out[i] = c.chars[i];
    return n;
  }
  if (c.chars[1] >= clusters_.size()) return 0;
  const std::u32string& cl = clusters_[c.chars[1]];
  int n = std::min<int>((int)cl.size(), max);
  for (int i = 0; i < n; i++) out[i] = cl[(size_t)i];
  return n;
}

void GridStore::setChars(Cell& c, const uint32_t* cps, int n) {
  if (n <= 2) {
    c.nchars = (uint8_t)std::max(0, n);
    c.chars[0] = n > 0 ? cps[0] : 0;
    c.chars[1] = n > 1 ? cps[1] : 0;
    return;
  }
  std::u32string key(cps, cps + n);
  auto it = clusterIds_.find(key);
  uint32_t id;
  if (it != clusterIds_.end()) id = it->second;
  else {
    id = (uint32_t)clusters_.size();
    clusters_.push_back(key);
    clusterIds_.emplace(std::move(key), id);
  }
  c.nchars = (uint8_t)std::min(n, 255);
  c.chars[0] = cps[0];
  c.chars[1] = id;
}

std::string GridStore::text(long absRow) const {
  const Row& r = row(absRow);
  size_t end = r.cells.size();
  while (end > 0 && (r.cells[end - 1].nchars == 0)) end--;
  std::string out;
  uint32_t cps[16];
  for (size_t i = 0; i < end; i++) {
    const Cell& c = r.cells[i];
    if (c.width == 0) continue;
    if (c.nchars == 0) { out += ' '; continue; }
    int n = chars(c, cps, 16);
    for (int k = 0; k < n; k++) putUtf8(out, cps[k]);
  }
  return out;
}

std::string GridStore::logicalLine(long absRow, long* firstRow, std::vector<int>* cellIndexOfChar) const {
  long lo = -(long)sb_.size();
  long first = std::max(lo, std::min(absRow, (long)rows_ - 1));
  while (first > lo && row(first - 1).wrapped) first--;
  if (firstRow) *firstRow = first;
  if (cellIndexOfChar) cellIndexOfChar->clear();
  std::string out;
  uint32_t cps[16];
  for (long r = first, off = 0; r < rows_; r++, off++) {
    const Row& rw = row(r);
    for (int col = 0; col < cols_; col++) {
      int cell = (int)off * cols_ + col;
      if (col < (int)rw.cells.size() && rw.cells[(size_t)col].width == 0) continue;
      int n = 0;
      if (col < (int)rw.cells.size() && rw.cells[(size_t)col].nchars > 0) n = chars(rw.cells[(size_t)col], cps, 16);
      if (n == 0) { cps[0] = ' '; n = 1; }
      for (int k = 0; k < n; k++) {
        putUtf8(out, cps[k]);
        if (cellIndexOfChar) {
          cellIndexOfChar->push_back(cell);
          if (cps[k] >= 0x10000) cellIndexOfChar->push_back(cell);   // a surrogate pair is two code units
        }
      }
    }
    if (!rw.wrapped) break;
  }
  return out;
}

GridStore::Packed GridStore::pack(const Row& r) const {
  Packed p;
  p.wrapped = r.wrapped;
  size_t end = r.cells.size();
  while (end > 0 && blankCell(r.cells[end - 1])) end--;
  if (end > 0 && end < r.cells.size() && r.cells[end - 1].width == 2) end++;   // keep the wide cell's continuation
  std::vector<uint16_t> starts;
  for (size_t i = 0; i < end; i++)
    if (i == 0 || r.cells[i].a != r.cells[i - 1].a) starts.push_back((uint16_t)i);
  uint16_t nruns = (uint16_t)starts.size();
  p.data.reserve(2 + nruns * (2 + sizeof(CellAttrs)) + end + 8);
  p.data.append((const char*)&nruns, 2);
  for (uint16_t s : starts) {
    p.data.append((const char*)&s, 2);
    p.data.append((const char*)&r.cells[s].a, sizeof(CellAttrs));
  }
  uint32_t cps[16];
  for (size_t i = 0; i < end; i++) {
    const Cell& c = r.cells[i];
    if (c.width == 0) continue;
    if (c.width == 2) p.data += (char)kWide;
    int n = c.nchars ? chars(c, cps, 16) : 0;
    if (n == 0) { p.data += (char)kBlank; continue; }
    for (int k = 0; k < n; k++) {
      if (k) p.data += (char)kJoin;
      putUtf8(p.data, cps[k]);
    }
  }
  p.data.shrink_to_fit();
  p.ncells = (uint16_t)std::min<size_t>(end, 65535);
  return p;
}

Row GridStore::unpack(const Packed& p) const {
  Row r;
  r.wrapped = p.wrapped;
  const std::string& d = p.data;
  if (d.size() < 2) return r;
  uint16_t nruns;
  memcpy(&nruns, d.data(), 2);
  size_t i = 2;
  std::vector<std::pair<uint16_t, CellAttrs>> runs(nruns);
  for (auto& run : runs) {
    memcpy(&run.first, d.data() + i, 2);
    memcpy(&run.second, d.data() + i + 2, sizeof(CellAttrs));
    i += 2 + sizeof(CellAttrs);
  }
  uint32_t cps[16];
  auto* self = const_cast<GridStore*>(this);   // setChars may add to the cluster table
  while (i < d.size()) {
    Cell c;
    if ((unsigned char)d[i] == kWide) { c.width = 2; i++; }
    if (i < d.size() && (unsigned char)d[i] == kBlank) {
      i++;
    } else if (i < d.size()) {
      int n = 0;
      cps[n++] = getUtf8(d, i);
      while (i < d.size() && (unsigned char)d[i] == kJoin) {
        i++;
        uint32_t cp = getUtf8(d, i);
        if (n < 16) cps[n++] = cp;
      }
      self->setChars(c, cps, n);
    }
    r.cells.push_back(c);
    if (c.width == 2) { Cell cont; cont.width = 0; r.cells.push_back(cont); }
  }
  size_t k = 0;
  for (size_t col = 0; col < r.cells.size(); col++) {
    while (k + 1 < runs.size() && runs[k + 1].first <= col) k++;
    if (!runs.empty()) r.cells[col].a = runs[k].second;
  }
  return r;
}

void GridStore::pushScrollback(Row&& r, bool continuation) {
  if (maxScrollback_ == 0) return;
  setNewestScrollbackWrapped(continuation);
  Packed p = pack(r);
  p.wrapped = false;   // the next push or setNewestScrollbackWrapped says
  sbBytes_ += packedCost(p);
  sb_.push_back(std::move(p));
  while (sb_.size() > maxScrollback_) {
    sbBytes_ -= packedCost(sb_.front());
    sb_.pop_front();
    firstSerial_++;
  }
}

bool GridStore::popScrollback(Row& out) {
  if (sb_.empty()) return false;
  uint64_t serial = firstSerial_ + sb_.size() - 1;
  out = unpack(sb_.back());
  for (Slot& s : decoded_)
    if (s.serial == serial) s.serial = UINT64_MAX;
  sbBytes_ -= packedCost(sb_.back());
  sb_.pop_back();
  return true;
}

void GridStore::clearScrollback() {
  firstSerial_ += sb_.size();
  sb_.clear();
  sb_.shrink_to_fit();
  sbBytes_ = 0;
  for (Slot& s : decoded_) s.serial = UINT64_MAX;
}

void GridStore::setNewestScrollbackWrapped(bool wrapped) {
  if (sb_.empty() || sb_.back().wrapped == wrapped) return;
  sb_.back().wrapped = wrapped;
  uint64_t serial = firstSerial_ + sb_.size() - 1;
  for (Slot& s : decoded_)
    if (s.serial == serial) s.row.wrapped = wrapped;
}

size_t GridStore::bytes() const {
  size_t n = sbBytes_ + screen_.size() * (sizeof(Row) + (size_t)cols_ * sizeof(Cell));
  for (const Slot& s : decoded_) n += s.row.cells.capacity() * sizeof(Cell);
  for (const std::u32string& c : clusters_) n += c.size() * 8 + 64;
  return n;
}

void GridStore::reflowScrollback(int cols) {
  if (cols < 1 || sb_.empty()) return;
  std::deque<Packed> out;
  size_t bytes = 0;
  auto emit = [&](Packed&& p) {
    bytes += packedCost(p);
    out.push_back(std::move(p));
  };
  std::vector<Cell> line;   // the logical line being joined
  bool joining = false;
  for (size_t i = 0; i < sb_.size(); i++) {
    Packed& p = sb_[i];
    if (!joining && !p.wrapped && p.ncells <= cols) {
      emit(std::move(p));
      continue;
    }
    Row r = unpack(p);
    line.insert(line.end(), r.cells.begin(), r.cells.end());
    joining = p.wrapped;
    bool last = i + 1 == sb_.size();
    if (joining && !last) continue;
    // Split the joined line at cols; a wide cell that would straddle the edge
    // moves to the next row, leaving a blank, as both terminals wrap it.
    size_t end = line.size();
    while (end > 0 && blankCell(line[end - 1])) end--;
    Row piece;
    size_t k = 0;
    do {
      piece.cells.clear();
      while (k < end && (int)piece.cells.size() < cols) {
        const Cell& c = line[k];
        if (c.width == 2) {
          if ((int)piece.cells.size() + 2 > cols) {
            if (piece.cells.empty()) { k += 2; continue; }   // cannot fit at all: drop it
            break;
          }
          piece.cells.push_back(c);
          piece.cells.push_back(k + 1 < line.size() ? line[k + 1] : Cell{});
          k += 2;
          continue;
        }
        if (c.width == 0) { k++; continue; }   // a continuation without its head
        piece.cells.push_back(c);
        k++;
      }
      // The final piece keeps the line's own flag: set when it runs on into the screen.
      piece.wrapped = k < end || (last && joining);
      emit(pack(piece));
      out.back().wrapped = piece.wrapped;
    } while (k < end);
    line.clear();
    joining = false;
  }
  while (out.size() > maxScrollback_) {
    bytes -= packedCost(out.front());
    out.pop_front();
  }
  firstSerial_ += sb_.size() + out.size();   // every serial is new; the decode ring is stale
  for (Slot& s : decoded_) s.serial = UINT64_MAX;
  sb_.swap(out);
  sbBytes_ = bytes;
}
