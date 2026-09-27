const res = await fetch("http://127.0.0.1:4000/api/v1/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "owner@example.com", password: "ChangeMe-Dev-Only-2026!" })
});
console.log(res.status);
console.log(await res.text());
