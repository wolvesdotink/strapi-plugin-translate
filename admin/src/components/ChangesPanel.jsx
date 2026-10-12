import React, { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useFetchClient, useForm } from "@strapi/strapi/admin";
import { Button, Flex, Typography } from "@strapi/design-system";
import { ChangesModal } from "./ChangesModal";
import pluginId from "../pluginId";

const ChangesPanelContent = ({ model, documentId, document, activeTab }) => {
  const { post } = useFetchClient();
  const { formatMessage } = useIntl();
  const t = (key, fallback, values) =>
    formatMessage(
      { id: `${pluginId}.changes.${key}`, defaultMessage: fallback },
      values,
    );
  const isSubmitting = useForm(
    "TranslationChanges",
    (state) => state.isSubmitting,
  );
  const [changes, setChanges] = useState(null),
    [open, setOpen] = useState(false),
    [error, setError] = useState(null);
  const saved = useRef(null),
    submitting = useRef(false),
    seen = useRef(null);
  const sourceLocale = document?.locale;
  useEffect(() => {
    if (isSubmitting) submitting.current = true;
  }, [isSubmitting]);
  const refresh = async (prompt = false) => {
    try {
      const { data } = await post("/translate/changes", {
        uid: model,
        documentId,
        sourceLocale,
      });
      setChanges(data);
      setError(null);
      if (
        prompt &&
        data.shouldPrompt &&
        data.modules.length &&
        data.revision !== seen.current
      ) {
        seen.current = data.revision;
        setOpen(true);
      }
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message);
    }
  };
  useEffect(() => {
    if (!documentId || !sourceLocale || activeTab === "published") return;
    const identity = `${model}:${documentId}:${sourceLocale}`;
    const previous = saved.current;
    const prompt =
      previous?.identity === identity &&
      previous.updatedAt !== document?.updatedAt &&
      submitting.current;
    saved.current = { identity, updatedAt: document?.updatedAt };
    if (prompt) submitting.current = false;
    let cancelled = false;
    // Wait for the refreshed document after the save. The source snapshot and
    // tracking record commit together; no click interception or DOM observers.
    const fetch = async () => {
      try {
        const { data } = await post("/translate/changes", {
          uid: model,
          documentId,
          sourceLocale,
        });
        if (cancelled) return;
        setChanges(data);
        setError(null);
        if (
          prompt &&
          data.shouldPrompt &&
          data.modules.length &&
          data.revision !== seen.current
        ) {
          seen.current = data.revision;
          setOpen(true);
        }
      } catch (err) {
        if (!cancelled)
          setError(err?.response?.data?.error?.message || err.message);
      }
    };
    fetch();
    return () => {
      cancelled = true;
    };
  }, [model, documentId, sourceLocale, document?.updatedAt, activeTab, post]);
  if (activeTab === "published" || changes?.enabled === false) return null;
  return (
    <Flex direction="column" alignItems="stretch" gap={3}>
      <Typography variant="pi" textColor={error ? "danger600" : "neutral600"}>
        {error ||
          (changes?.modules?.length
            ? t(
                "pending",
                "{count, plural, one {# module has} other {# modules have}} pending changes",
                { count: changes.modules.length },
              )
            : t(
                "none",
                "Save a source change to translate only the updated content.",
              ))}
      </Typography>
      <Button
        variant="secondary"
        disabled={!changes?.modules?.length}
        onClick={() => setOpen(true)}
      >
        {t("review", "Review saved changes")}
      </Button>
      {error && (
        <Button variant="tertiary" onClick={() => refresh()}>
          {t("retry", "Retry")}
        </Button>
      )}
      {open && (
        <ChangesModal
          open={open}
          onClose={() => setOpen(false)}
          model={model}
          documentId={documentId}
          sourceLocale={sourceLocale}
          changes={changes}
          onApplied={() => refresh()}
          onRefresh={() => refresh()}
        />
      )}
    </Flex>
  );
};

export default function ChangesPanel(props) {
  const { formatMessage } = useIntl();
  const documentId = props.documentId || props.document?.documentId;
  if (!documentId || !props.document?.locale) return null;
  return {
    title: formatMessage({
      id: `${pluginId}.changes.panel`,
      defaultMessage: "Translation changes",
    }),
    content: <ChangesPanelContent {...props} documentId={documentId} />,
  };
}
