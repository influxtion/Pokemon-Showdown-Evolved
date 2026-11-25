'use strict';

// Runs in the remote client. Keep native controls and handlers, including server settings.
function openProfile() {
  if (!window.app || !window.Room || !window.OptionsPopup || !app.user ||
      typeof app.addRoom !== 'function' || typeof app.focusRoom !== 'function') return false;
  const id = 'evolved-profile';
  if (!app.rooms[id]) {
    const ProfileOptions = OptionsPopup.extend({
      className: 'sd-profile-options',
      update() {
        const active = document.activeElement;
        const status = this.el.querySelector('[name="statustext"]');
        const draft = status ? { value: status.value, focused: status === active,
          start: status.selectionStart, end: status.selectionEnd } : null;
        OptionsPopup.prototype.update.call(this);
        const nodes = Array.from(this.el.children);
        const sections = {};
        const section = (key, title, description) => {
          const node = document.createElement('section');
          node.className = 'sd-profile-section sd-profile-' + key;
          const heading = document.createElement('h2');
          heading.textContent = title;
          node.append(heading);
          if (description) {
            const note = document.createElement('p');
            note.className = 'sd-profile-note';
            note.textContent = description;
            node.append(note);
          }
          sections[key] = node;
          return node;
        };
        section('account', 'Your profile', 'Choose how you appear on Showdown.');
        section('chat', 'Chat preferences', 'Messages, highlights, timestamps and text formatting. Changes save as you go.');
        section('graphics', 'Battle graphics', 'App colors, background and layout are managed in Settings.');
        let target = sections.account;
        let clientPromo = false;
        for (const node of nodes) {
          if (node.tagName === 'HR') continue;
          const heading = node.querySelector('strong');
          if (heading && node.textContent.trim() === 'Graphics') {
            target = sections.graphics;
            clientPromo = false;
            continue;
          }
          if (heading && node.textContent.trim() === 'Chat') {
            target = sections.chat;
            continue;
          }
          if (node.querySelector('a[href="/newclient"], select[name="defaultclient"]') ||
              /^(This is the old client\.|We're working on a new client!)/.test(node.textContent.trim())) {
            clientPromo = true;
            continue;
          }
          if (clientPromo) continue;
          if (node.querySelector('[name="theme"], [name="onepanel"], [name="background"]')) continue;
          if (node.querySelector('[name="syncteams"]')) {
            sections.account.append(node);
            continue;
          }
          if (node.classList.contains('buttonbar')) target = sections.account;
          target.append(node);
        }
        const sound = document.createElement('p');
        sound.innerHTML = '<button class="button" name="sounds">Sound preferences</button>';
        sections.account.append(sound);
        const avatar = sections.account.querySelector('img');
        if (avatar) avatar.alt = 'Your Showdown avatar';
        this.el.replaceChildren(sections.account, sections.chat, sections.graphics);
        const input = this.el.querySelector('[name="statustext"]');
        if (input) {
          input.setAttribute('aria-label', 'Status message');
          this.el.querySelector('[name="editstatus"]').setAttribute('aria-label', 'Save status');
        }
        if (draft) {
          if (input) {
            input.value = draft.value;
            if (draft.focused) input.focus();
            input.setSelectionRange(draft.start, draft.end);
          }
        }
      },
      sounds() { app.addPopup(SoundsPopup); },
      // This view lives in a room, outside the popup stack.
      close() { this.update(); },
    });
    const ProfileRoom = Room.extend({
      type: 'profile',
      title: 'Profile',
      initialize() {
        this.$el.addClass('sd-profile-room');
        this.optionsView = new ProfileOptions({});
        this.el.append(this.optionsView.el);
      },
      focus() { this.optionsView.update(); },
      // The embedded native view owns its controls. Do not rebuild on background clicks.
      dispatchClickBackground() { app.dismissPopups(); },
      destroy() {
        app.user.off(null, null, this.optionsView);
        this.optionsView.remove();
        Room.prototype.destroy.apply(this, arguments);
      },
    });
    app.addRoom(id, ProfileRoom, true, 'Profile');
  }
  app.focusRoom(id);
  return true;
}

module.exports = { openProfile };
