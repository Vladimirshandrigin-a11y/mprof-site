import type { Metadata } from "next";
import { LegalPage } from "../components/LegalPage";

export const metadata: Metadata = {
  title: "Контакты — M-Prof",
  description:
    "Контактные данные сервиса M-Prof: реквизиты, email и телефон для связи.",
};

export default function ContactsPage() {
  return (
    <LegalPage eyebrow="Реквизиты" title="Контакты">
      <div className="lg-card">
        <div className="lg-row">
          <div className="lg-row-k">ФИО</div>
          <div className="lg-row-v">Щандригин Владимир Андреевич</div>
        </div>
        <div className="lg-row">
          <div className="lg-row-k">ИНН</div>
          <div className="lg-row-v">263213962604</div>
        </div>
        <div className="lg-row">
          <div className="lg-row-k">Email</div>
          <div className="lg-row-v">
            <a href="mailto:ozonpochtamail@mail.ru">ozonpochtamail@mail.ru</a>
          </div>
        </div>
        <div className="lg-row">
          <div className="lg-row-k">Телефон</div>
          <div className="lg-row-v">
            <a href="tel:+79614887472">+7 (961) 488-74-72</a>
          </div>
        </div>
      </div>

      <h2>О сервисе</h2>
      <p>
        M-Prof — сервис автоматического расчета чистой прибыли для продавцов
        маркетплейсов Ozon и Wildberries.
      </p>
    </LegalPage>
  );
}
