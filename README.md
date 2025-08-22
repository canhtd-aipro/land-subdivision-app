# Land Subdivision App – README

Ứng dụng React đơn–file cho phép:

- vẽ **ranh đất (boundary)**, **điểm tiếp giáp đường công cộng (entry points)**, **đường nội bộ (polygon)**, **các lô (polygon)**,
- **snap** vào đỉnh/cạnh, **axis‑lock** (giữ Shift), **zoom/pan** theo viewBox,
- **xuất JSON** đúng schema yêu cầu và **xuất PNG** snapshot.

> Component chính: `` – chỉ cần nhúng vào một dự án React (Vite/Next.js) là chạy được.

---

## 1) Yêu cầu hệ thống

- **Node.js**: khuyến nghị **LTS v18** hoặc **v20**
- **Trình quản lý gói**: đi kèm Node (`npm`), hoặc dùng `pnpm`/`yarn`
- **Trình duyệt**: Chrome/Edge/Firefox/Safari gần đây

---

## 2) Cài đặt Node.js trên máy cá nhân

Bạn có 2 hướng: **(A) dùng nvm** (khuyến nghị vì dễ đổi phiên bản) hoặc **(B) cài trực tiếp**.

### A) Cài bằng nvm (khuyên dùng)

#### macOS (Homebrew)

1. Cài nvm:
   ```bash
   brew install nvm
   ```
2. Thêm cấu hình vào shell profile (Apple Silicon thường là `/opt/homebrew`, Intel là `/usr/local`):
   ```bash
   # Apple Silicon (zsh)
   mkdir -p ~/.nvm
   echo 'export NVM_DIR="$HOME/.nvm"' >> ~/.zshrc
   echo '[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && . "/opt/homebrew/opt/nvm/nvm.sh"' >> ~/.zshrc
   echo '[ -s "/opt/homebrew/opt/nvm/etc/bash_completion.d/nvm" ] && . "/opt/homebrew/opt/nvm/etc/bash_completion.d/nvm"' >> ~/.zshrc
   # Intel Mac (nếu dùng Homebrew /usr/local): thay /opt/homebrew bằng /usr/local
   ```
3. Mở terminal mới rồi cài Node LTS:
   ```bash
   nvm install 20
   nvm use 20
   nvm alias default 20
   node -v && npm -v
   ```

#### Linux (Ubuntu/Debian/Fedora…)

1. Cài nvm qua script chính thức:
   ```bash
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
   # nạp nvm vào shell hiện tại
   export NVM_DIR="$HOME/.nvm"
   [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
   ```
2. Cài Node LTS:
   ```bash
   nvm install 20
   nvm use 20
   nvm alias default 20
   node -v && npm -v
   ```

#### Windows (nvm-windows)

1. Tải **nvm-windows** (bản phát hành `.exe`) từ repo `coreybutler/nvm-windows` và chạy cài đặt.
2. Mở PowerShell mới và cài Node:
   ```powershell
   nvm install 20
   nvm use 20
   node -v
   npm -v
   ```

> Lưu ý: nếu đã cài Node trước đó bằng bộ cài .msi, nên gỡ để tránh xung đột PATH.

### B) Cài trực tiếp (không dùng nvm)

- **Windows/macOS**: dùng installer chính thức từ trang Node.js, sau đó kiểm tra:
  ```bash
  node -v
  npm -v
  ```
- **Ubuntu/Debian (NodeSource)**:
  ```bash
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  node -v && npm -v
  ```
- **Fedora/RHEL/CentOS (NodeSource)**:
  ```bash
  sudo dnf install -y curl
  curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
  sudo dnf install -y nodejs
  node -v && npm -v
  ```

### Kiểm tra & PATH

- `node -v` và `npm -v` phải in ra phiên bản.
- Nếu Windows báo sai phiên bản, chạy `where node` để xem Node đang lấy từ đâu; với nvm-windows, đường dẫn nên nằm trong `C:\Program Files\nodejs` (symlink của nvm) hoặc `C:\Users\<you>\AppData\Roaming\nvm\...`.

---

## 3) Khởi tạo nhanh với Vite (khuyên dùng)

### A. Tạo dự án

```bash
npm create vite@latest land-subdivision -- --template react
# hoặc: npm create vite@latest land-subdivision -- --template react-swc
cd land-subdivision
npm install
```

### B. Cài Tailwind CSS (UI trong code dùng class Tailwind)

```bash
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
```

``:

```js
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: { extend: {} },
  plugins: [],
}
```

``:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

Trong `` nhớ import `index.css`.

### C. Thêm component

- Tạo `` và dán toàn bộ code component vào.
- Sửa ``:

```jsx
import LandSubdivisionApp from './LandSubdivisionApp'
export default function App(){
  return <LandSubdivisionApp />
}
```

### D. Chạy dev

```bash
npm run dev
```

Mở URL (thường `http://localhost:5173`).

### E. Build production

```bash
npm run build
npm run preview
```

Thư mục build: `dist/` (deploy lên Netlify/Vercel/GitHub Pages tùy ý).

---

## 4) Sử dụng nhanh

1. **Boundary** → MODE *Boundary* → click các đỉnh → **Close shape**.
2. **Public Road entry points** → MODE *Public Road entry points* → click 2 điểm tiếp giáp (có thể thêm) → chỉnh `Public width`.
3. **Internal Road** → MODE *Internal Road (polygon)* → vẽ đa giác → **Close shape**.
4. **Lot** → MODE *Lot (polygon)* → vẽ đa giác → **Close shape**.
5. **Snap/Axis‑lock**: trỏ gần đỉnh/cạnh để snap; giữ **Shift** để khóa ngang/dọc.
6. **Zoom/Pan**: cuộn chuột để zoom; dùng nút **Fit/Reset**.
7. **Export**: bấm **Export JSON + PNG** để tải đúng schema + ảnh PNG.

---

## 5) JSON xuất ra (mẫu rút gọn)

```json
{
  "input": {
    "land_id": "L001",
    "boundary": [[x,y], ... , [x0,y0]],
    "roads": [
      {
        "road_id": "R003",
        "is_public": true,
        "width": 12,
        "entry_points": [[x,y], [x,y]],
        "connected_to_public_road": null,
        "road_to_lot_mapping": []
      }
    ]
  },
  "output": {
    "internal_roads": [
      {
        "road_id": "R001",
        "polygon": [[x,y], ...],
        "is_public": false,
        "width": 6,
        "connected_to_public_road": true,
        "road_to_lot_mapping": []
      }
    ],
    "lots": [
      {
        "lot_id": "L001-01",
        "polygon": [[x,y], ...],
        "area": 244.7,
        "front_road": "R001"
      }
    ]
  }
}
```

> Boundary được **đóng vòng** khi export nếu bạn đã bấm "Close shape".

---

## 6) Phím/tính năng hữu ích

- **Undo**: xóa đỉnh cuối đang vẽ / phần tử cuối ở mode hiện tại
- **Clear All**: xóa toàn bộ
- **Auto‑scale new shapes**: tự scale đa giác mới về diện tích mục tiêu (mặc định 200 m² cho Lot)
- **Scale & Area panel**: scale toàn cục quanh anchor (centroid/origin/custom) theo % hoặc tới target area (diện tích boundary)

---

## 7) Kiểm thử tích hợp sẵn

File có **inline smoke tests**: chạy **một lần** khi load trang (xem Console nếu có lỗi). Các test không gọi những phần phụ thuộc DOM (như export PNG) để tránh false positive.

> Có thể bọc test chỉ chạy ở DEV: `if (process.env.NODE_ENV !== "production") { ... }`

---

## 8) Troubleshooting

- **Tailwind không hoạt động**: kiểm tra `tailwind.config.js` (mục `content`), import `index.css` trong `main.jsx`.
- **Lỗi JSX/Syntax**: đảm bảo dán **đủ** component (đặc biệt section "Current drawing path" và block tests). Tránh comment dòng bị hở.
- **PNG trắng**: chạy qua dev server (`npm run dev`) thay vì mở file HTML trực tiếp.
- **Sai phiên bản Node**: dùng `nvm use 20` (hoặc `nvm alias default 20`). Trên Windows kiểm tra `where node` để sửa PATH.

---

## 9) Bảo mật & Quyền riêng tư

Ứng dụng chạy **hoàn toàn cục bộ**, không gọi API bên ngoài. JSON/PNG được tạo **trên trình duyệt**.

---

## 10) Giấy phép

Mặc định dùng nội bộ. Nếu bạn cần MIT/Apache‑2.0… hãy cho biết để thêm vào.

---

## 11) Cần làm thêm?

- Kéo/thả di chuyển đỉnh; xóa đỉnh bằng phím
- Snap theo lưới; ràng buộc diện tích tối thiểu; góc vuông vức; tỉ lệ cạnh
- Tự động gán `front_road` theo cạnh gần đường nội bộ nhất
- Xuất **GeoJSON/DXF/JWW**

