/**
 * ForgeWizard — Agentiface multi-step form/wizard component
 *
 * Extends isc.VLayout with step indicator, prev/next navigation,
 * per-step validation, and animated transitions.
 *
 * Usage:
 *   isc.ForgeWizard.create({
 *     steps: [
 *       { title: 'Basic Info', form: myForm1 },
 *       { title: 'Details',    form: myForm2, validate: function() { return myForm2.validate(); } },
 *       { title: 'Review',     pane: myDetailViewer },
 *     ],
 *     onComplete: function(data) { console.log('Wizard done', data); }
 *   });
 */

isc.defineClass("ForgeWizard", "VLayout").addProperties({
  width: "100%",
  height: "100%",
  layoutMargin: 16,
  membersMargin: 12,

  /**
   * Steps array. Each step: { title, form?, pane?, validate? }
   * - form: a DynamicForm (provides getValues/validate)
   * - pane: any Canvas (for non-form steps like review)
   * - validate: optional function returning true/false
   */
  steps: null,

  /** Current step index (0-based) */
  currentStep: 0,

  /** Show the step indicator bar */
  showStepIndicator: true,

  /** Allow clicking completed steps to jump back */
  allowStepClick: true,

  /** Called when the user clicks Finish on the last step */
  onComplete: null,

  /** Called when step changes: function(stepIndex, direction) */
  onStepChange: null,

  // Internal refs
  _indicatorCanvas: null,
  _contentCanvas: null,
  _buttonBar: null,
  _prevBtn: null,
  _nextBtn: null,

  initWidget: function () {
    this.Super("initWidget", arguments);

    if (!this.steps || this.steps.length === 0) {
      console.warn("[ForgeWizard] No steps provided");
      return;
    }

    // Step indicator
    if (this.showStepIndicator) {
      this._indicatorCanvas = isc.Canvas.create({
        width: "100%",
        height: 60,
        contents: this._buildIndicatorHTML(),
      });
      this.addMember(this._indicatorCanvas);
    }

    // Content container
    this._contentCanvas = isc.Canvas.create({
      width: "100%",
      height: "*",
      overflow: "auto",
    });
    this.addMember(this._contentCanvas);

    // Button bar
    this._prevBtn = isc.Button.create({
      title: "Back",
      width: 80,
      click: this._prevStep.bind(this),
    });

    this._nextBtn = isc.Button.create({
      title: "Next",
      width: 80,
      click: this._nextStep.bind(this),
    });

    this._buttonBar = isc.HLayout.create({
      width: "100%",
      height: 40,
      membersMargin: 8,
      align: "right",
      members: [this._prevBtn, this._nextBtn],
    });
    this.addMember(this._buttonBar);

    // Show first step
    this._showStep(0, "right");
  },

  _buildIndicatorHTML: function () {
    var steps = this.steps;
    var current = this.currentStep;
    var html = '<div class="af-wizard-steps">';

    for (var i = 0; i < steps.length; i++) {
      if (i > 0) {
        var connClass = i <= current ? "af-wizard-connector af-wizard-connector-done" : "af-wizard-connector";
        html += '<div class="' + connClass + '"></div>';
      }

      html += '<div class="af-wizard-step">';

      var dotClass = "af-wizard-dot";
      if (i < current) dotClass += " af-wizard-dot-done";
      else if (i === current) dotClass += " af-wizard-dot-active";

      var content = i < current ? "\u2713" : String(i + 1);
      html += '<div class="' + dotClass + '">' + content + "</div>";

      var labelClass = "af-wizard-label";
      if (i === current) labelClass += " af-wizard-label-active";
      html += '<span class="' + labelClass + '">' + this._escHtml(steps[i].title || "Step " + (i + 1)) + "</span>";

      html += "</div>";
    }

    html += "</div>";
    return html;
  },

  _showStep: function (index, direction) {
    var step = this.steps[index];
    if (!step) return;

    this.currentStep = index;

    // Update indicator
    if (this._indicatorCanvas) {
      this._indicatorCanvas.setContents(this._buildIndicatorHTML());
    }

    // Show the step content
    var pane = step.form || step.pane;
    if (pane) {
      // Remove all current children from content area
      var children = this._contentCanvas.children;
      if (children) {
        for (var i = children.length - 1; i >= 0; i--) {
          this._contentCanvas.removeChild(children[i]);
          children[i].hide();
        }
      }

      pane.show();
      this._contentCanvas.addChild(pane);

      // Apply entry animation class
      var handle = pane.getHandle ? pane.getHandle() : null;
      if (handle) {
        var cls = direction === "left" ? "af-step-enter-left" : "af-step-enter-right";
        handle.classList.remove("af-step-enter-left", "af-step-enter-right");
        // Force reflow before adding class
        void handle.offsetWidth;
        handle.classList.add(cls);
      }
    }

    // Update buttons
    this._prevBtn.setDisabled(index === 0);
    this._nextBtn.setTitle(index === this.steps.length - 1 ? "Finish" : "Next");

    // Callback
    if (this.onStepChange) {
      try { this.onStepChange(index, direction); } catch (e) { /* ignore */ }
    }
  },

  _nextStep: function () {
    var step = this.steps[this.currentStep];

    // Validate current step
    if (step.validate) {
      if (step.validate() === false) return;
    } else if (step.form && step.form.validate) {
      if (!step.form.validate()) return;
    }

    if (this.currentStep >= this.steps.length - 1) {
      // Last step — complete
      this._finish();
      return;
    }

    this._showStep(this.currentStep + 1, "right");
  },

  _prevStep: function () {
    if (this.currentStep <= 0) return;
    this._showStep(this.currentStep - 1, "left");
  },

  _finish: function () {
    // Collect all form values
    var data = {};
    for (var i = 0; i < this.steps.length; i++) {
      if (this.steps[i].form && this.steps[i].form.getValues) {
        Object.assign(data, this.steps[i].form.getValues());
      }
    }

    if (this.onComplete) {
      try { this.onComplete(data); } catch (e) { console.error("[ForgeWizard] onComplete error:", e); }
    }

    // Show success toast if available
    if (window.Agentiface && Agentiface.Toast) {
      Agentiface.Toast.success("Wizard completed");
    }
  },

  /** Programmatically jump to a step */
  goToStep: function (index) {
    if (index < 0 || index >= this.steps.length) return;
    var direction = index > this.currentStep ? "right" : "left";
    this._showStep(index, direction);
  },

  /** Get current step index */
  getCurrentStep: function () {
    return this.currentStep;
  },

  /** Get all collected form values across steps */
  getValues: function () {
    var data = {};
    for (var i = 0; i < this.steps.length; i++) {
      if (this.steps[i].form && this.steps[i].form.getValues) {
        Object.assign(data, this.steps[i].form.getValues());
      }
    }
    return data;
  },

  _escHtml: function (str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  },
});
