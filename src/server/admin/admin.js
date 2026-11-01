// Confirmation prompts for destructive admin forms (CSP forbids inline handlers).
for (const form of document.querySelectorAll("form[data-confirm]")) {
  form.addEventListener("submit", (e) => {
    if (!confirm(form.dataset.confirm)) e.preventDefault();
  });
}

// Passkey sign-in and enrollment. webauthn.js is @simplewebauthn/browser's UMD bundle.
const webauthn = window.SimpleWebAuthnBrowser;
const errorBox = document.getElementById("passkey-error");

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

async function postJson(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status}).`);
  return data;
}

function describe(err) {
  if (err && err.name === "NotAllowedError") return "Cancelled or timed out. Try again.";
  if (err && err.name === "InvalidStateError") return "This device already has a passkey for this admin.";
  return (err && err.message) || "Something went wrong. Try again.";
}

async function run(button, ceremony) {
  errorBox.hidden = true;
  button.disabled = true;
  try {
    const { redirect } = await ceremony();
    location.assign(redirect);
  } catch (err) {
    showError(describe(err));
    button.disabled = false;
  }
}

const loginButton = document.querySelector("button[data-passkey=login]");
if (loginButton) {
  if (!webauthn || !webauthn.browserSupportsWebAuthn()) showError("This browser doesn't support passkeys.");
  loginButton.addEventListener("click", () =>
    run(loginButton, async () => {
      const optionsJSON = await postJson("/admin/login/options", {});
      const response = await webauthn.startAuthentication({ optionsJSON });
      return postJson("/admin/login/verify", { response });
    }),
  );
}

const enrollForm = document.querySelector("form[data-passkey=enroll]");
if (enrollForm) {
  if (!webauthn || !webauthn.browserSupportsWebAuthn()) showError("This browser doesn't support passkeys.");
  enrollForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const code = enrollForm.dataset.code;
    const name = enrollForm.elements.name.value.trim();
    run(enrollForm.querySelector("button"), async () => {
      const optionsJSON = await postJson("/admin/enroll/options", { code });
      const response = await webauthn.startRegistration({ optionsJSON });
      return postJson("/admin/enroll/verify", { code, name, response });
    });
  });
}

// Invitations: copy the public link, guess the time zone for new events, check and preview the picture.
for (const button of document.querySelectorAll("button[data-copy]")) {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = "Copy"), 1500);
    } catch {
      button.previousElementSibling?.select();
    }
  });
}
for (const input of document.querySelectorAll("input[data-select-on-focus]")) {
  input.addEventListener("focus", () => input.select());
}
const inviteForm = document.querySelector("form[data-invite-form]");
if (inviteForm) {
  const tz = inviteForm.elements.timezone;
  if (inviteForm.hasAttribute("data-guess-timezone") && tz) {
    const guess = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if ([...tz.options].some((o) => o.value === guess)) tz.value = guess;
  }
  const file = inviteForm.elements.image;
  file?.addEventListener("change", () => {
    inviteForm.querySelector(".image-preview")?.remove();
    const f = file.files[0];
    file.setCustomValidity(f && f.size > Number(file.dataset.maxBytes) ? "That picture is too big (max 15 MB)." : "");
    file.reportValidity();
    if (!f || !f.type.startsWith("image/")) return;
    const img = document.createElement("img");
    img.className = "image-preview";
    img.alt = "Selected picture";
    img.src = URL.createObjectURL(f);
    file.closest("label").after(img);
  });
}
